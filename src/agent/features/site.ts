// Trip pages: every trip is published to the web (see src/site/) and Atlas links the section
// that changed when something meaningful happens — a new trip, a new or changed itinerary, a
// weather swap, finished research. Chat lines sync to the page silently.
//
// The page's content is Atlas's own structured input: the agent writes the day-by-day plan
// (update_itinerary) and the trip summary (set_trip_summary) as validated JSON, and the site shows
// exactly that. Money, votes and booking links stay deterministic.
import { now } from "../../clock.ts";
import { childLog } from "../../log.ts";
import { one } from "../../db/pool.ts";
import { activeMembers, labelOf, type ChatRow } from "../../db/repos/core.ts";
import { enqueueJob } from "../../pipeline/jobs.ts";
import { groupView, interestWeights } from "../../profile/groupView.ts";
import { profilesFor } from "../../profile/store.ts";
import { draftItinerary } from "../../trips/itinerary.ts";
import { itineraryInput, itineraryText, mergeItinerary, problem, summaryInput } from "../../site/content.ts";
import { ANNOUNCE_JOB, SYNC_JOB, hubUrl, linkAction, pageUrl, publishTrip, requestAnnounce, requestSync } from "../../site/publish.ts";
import { siteFor } from "../../site/store.ts";
import type { SiteSection } from "../../site/types.ts";
import { destinationById } from "../../trips/catalog.ts";
import { tripById, updateTrip, type TripRow } from "../../trips/state.ts";
import type { AppServices, Feature, TurnCtx } from "../feature.ts";
import { ToolError, say, type Tool } from "../tools.ts";

const log = childLog({ component: "site" });
const SECTIONS: SiteSection[] = ["overview", "itinerary", "research", "chat"];
export const ITINERARY_NUDGE_JOB = "site.itinerary_nudge";
const NUDGE_TRIES = 3;

/**
 * Publish the focused trip now and post the section's link with this turn's replies (after
 * them, so the link follows the news). If the store is down, a job retries and posts it later.
 */
export async function announceSection(tc: TurnCtx, section: SiteSection): Promise<boolean> {
  try {
    const published = await publishTrip(tc.cfg, tc.trip.id, tc.chat, section);
    if (!published) return false;
    tc.out.push(linkAction(published.url, section));
    tc.notes.set("site.announced", section);
    return true;
  } catch (err) {
    log.warn({ err: (err as Error).message, tripId: tc.trip.id, section }, "trip page publish failed; retrying in the background");
    await requestAnnounce(tc.cfg, tc.trip, section);
    return false;
  }
}

async function chatRow(chatId: number): Promise<ChatRow | undefined> {
  return one<ChatRow>(`SELECT * FROM chats WHERE id = $1`, [chatId]);
}

const hasPlan = (t: Pick<TripRow, "itinerary">) => t.itinerary.some((d) => d.items.length > 0);

const updateItinerary: Tool = {
  decl: {
    name: "update_itinerary",
    description:
      "Write or change the trip's day-by-day plan on the trip page. Send only the days you're writing; each one replaces that day, other days stay. Use catalog ideas from the situation when they fit the group, and real place names. Posts the itinerary link itself. No prices (costs come from the catalog).",
    parameters: {
      type: "object",
      properties: {
        days: {
          type: "array",
          items: {
            type: "object",
            properties: {
              date: { type: "string", description: "YYYY-MM-DD, within the trip's dates" },
              title: { type: "string", description: "short theme for the day, e.g. \"old town + food\"" },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string", description: "the activity or place" },
                    time: { type: "string", description: "e.g. \"9am\", \"morning\", \"after dinner\"" },
                    setting: { type: "string", enum: ["outdoor", "indoor", "either"] },
                    notes: { type: "string", description: "one useful line: why, what to book, who it's for" },
                  },
                  required: ["name", "setting"],
                },
              },
            },
            required: ["date", "items"],
          },
        },
      },
      required: ["days"],
    },
  },
  async run(args, ctx) {
    const tc = ctx as TurnCtx;
    const trip = tc.trip;
    if (!trip.start_date || !trip.end_date) throw new ToolError("the trip has no dates yet; agree on them (set_trip_dates) before writing the plan");
    const parsed = itineraryInput.safeParse(args);
    if (!parsed.success) throw new ToolError(problem(parsed.error));
    let itinerary;
    try {
      itinerary = mergeItinerary(trip.itinerary, parsed.data, { start: trip.start_date, end: trip.end_date, dest: trip.destination_id ? destinationById(trip.destination_id) : undefined });
    } catch (err) {
      throw new ToolError((err as Error).message);
    }
    tc.trip = await updateTrip(trip.id, { itinerary });
    const linked = tc.notes.get("site.announced") === "itinerary" || (await announceSection(tc, "itinerary"));
    if (!linked) say(tc, itineraryText(itinerary));
    const planned = itinerary.filter((d) => d.items.length).length;
    return {
      ok: true,
      data: { daysPlanned: planned, daysTotal: itinerary.length },
      next: linked ? "plan saved and its page link was posted; at most a one-line lead-in, don't list the plan in chat" : "plan saved and posted in chat; no need to repeat it",
    };
  },
};

const setTripSummary: Tool = {
  decl: {
    name: "set_trip_summary",
    description:
      "Write the 2–3 sentence summary at the top of the trip page (where the plan stands, what's decided, what's next), and optionally rename the trip. Update it when something important changes. Silent: nothing is posted in chat. No prices.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "2–3 plain sentences for someone opening the page" },
        title: { type: "string", description: "only to rename the trip, e.g. \"spring break in egypt\"" },
      },
      required: ["summary"],
    },
  },
  async run(args, ctx) {
    const tc = ctx as TurnCtx;
    const parsed = summaryInput.safeParse(args);
    if (!parsed.success) throw new ToolError(problem(parsed.error));
    tc.trip = await updateTrip(tc.trip.id, { summary: parsed.data.summary, ...(parsed.data.title ? { title: parsed.data.title.toLowerCase() } : {}) });
    await requestSync(tc.cfg, tc.trip);
    return { ok: true, next: "saved to the trip page; don't mention it unless asked" };
  },
};

/** What the agent needs to write the plan: its state, and catalog ideas ranked by group interest. */
async function planLines(tc: TurnCtx): Promise<string[]> {
  const t = tc.trip;
  if (!t.destination_id || !t.start_date || !t.end_date) return [];
  const dest = destinationById(t.destination_id);
  const lines = [
    hasPlan(t)
      ? `itinerary: written for ${t.itinerary.filter((d) => d.items.length).length} of ${t.itinerary.length} days (change days with update_itinerary)`
      : "itinerary: NOT WRITTEN YET. write the day-by-day plan with update_itinerary",
  ];
  if (t.summary) lines.push(`page summary: ${t.summary}`);
  else lines.push("page summary: none yet (set_trip_summary)");
  if (dest && !hasPlan(t)) {
    const weights = interestWeights(await tc.view());
    const score = (tags: readonly string[]) => tags.reduce((s, tag) => s + (weights[tag] ?? 0), 0);
    const ideas = [...dest.activities].sort((a, b) => score(b.tags) - score(a.tags)).slice(0, 12);
    lines.push(`ideas in ${dest.name} (most liked first): ${ideas.map((a) => `${a.name} (${a.setting}, ${a.durationHours}h, ${a.tags.join("/")})`).join("; ")}`);
  }
  return lines;
}

export const siteFeature: Feature = {
  name: "site",
  tools: [updateItinerary, setTripSummary],

  async situation(tc) {
    const site = siteFor(tc.cfg);
    const lines = await planLines(tc);
    if (site && tc.chat.is_group) {
      lines.push(
        `this trip's page (share it when someone asks for the link or the plan): ${pageUrl(site.baseUrl, tc.trip.public_id, "overview")}`,
        `all of this chat's trips: ${hubUrl(site.baseUrl, tc.chat.public_id)}`,
        "links to the page are posted automatically when the trip, itinerary or research changes; don't paste them again right after",
      );
    }
    return lines.length ? { title: "trip page", lines } : null;
  },

  async afterTurn(tc) {
    if (!tc.chat.is_group) return;
    await requestSync(tc.cfg, tc.trip).catch((err) => log.warn({ err: (err as Error).message }, "couldn't queue trip page sync"));
  },

  async onTripLocked(trip, tc) {
    // Locked by a vote (no agent in this turn): ask Atlas to write the plan on a follow-up turn.
    if (tc.notes.get("itinerary.byAgent") || hasPlan(trip) || !trip.start_date) return;
    await enqueueJob(ITINERARY_NUDGE_JOB, { tripId: trip.id, attempt: 1 }, { dueAt: new Date(now().getTime() + 3_000), singletonKey: `site:plan:${trip.id}` });
  },

  jobs(svc) {
    return {
      [SYNC_JOB]: async (payload) => {
        const trip = await tripById(Number(payload.tripId));
        const chat = trip && (await chatRow(trip.chat_id));
        if (!trip || !chat) return;
        await publishTrip(svc.cfg, trip.id, chat);
      },
      [ITINERARY_NUDGE_JOB]: async (payload) => {
        const trip = await tripById(Number(payload.tripId));
        if (!trip || hasPlan(trip) || trip.status !== "locked") return;
        const focused = await one<{ focus_trip_id: number | null }>(`SELECT focus_trip_id FROM chats WHERE id = $1`, [trip.chat_id]);
        if (focused?.focus_trip_id !== trip.id) return;
        const attempt = Number(payload.attempt ?? 1);
        // Atlas never got to it (busy chat, models out of quota): a drafted plan beats an empty page.
        if (attempt > NUDGE_TRIES) return draftFallback(svc, trip);
        await svc.nudge(trip.chat_id, `${trip.destination_name ?? "the trip"} just got locked in by the vote. write the day-by-day plan now with update_itinerary (ideas under trip page), then at most one short line`);
        // A nudge is skipped while another turn is running; check back until the plan exists.
        return { rescheduleAt: new Date(now().getTime() + 90_000), payload: { tripId: trip.id, attempt: attempt + 1 } };
      },
      [ANNOUNCE_JOB]: async (payload, { jobId }) => {
        const trip = await tripById(Number(payload.tripId));
        const chat = trip && (await chatRow(trip.chat_id));
        const section = SECTIONS.includes(payload.section as SiteSection) ? (payload.section as SiteSection) : "overview";
        if (!trip || !chat) return;
        const published = await publishTrip(svc.cfg, trip.id, chat, section);
        if (published) await svc.post(chat.id, `site${jobId}`, [linkAction(published.url, section)]);
      },
    };
  },
};

/** The catalog's day-by-day draft for the group's interests, saved and linked like Atlas's own. */
async function draftFallback(svc: AppServices, trip: TripRow): Promise<void> {
  const dest = trip.destination_id ? destinationById(trip.destination_id) : undefined;
  if (!dest || !trip.start_date || !trip.end_date) return;
  const members = await activeMembers(trip.chat_id);
  const profiles = await profilesFor(members.map((m) => m.id), { tripId: trip.id });
  const view = groupView(
    members.map((m) => ({ personId: m.id, label: labelOf(m), profile: profiles.get(m.id)! })),
    trip.start_date,
  );
  const itinerary = draftItinerary(dest, trip.start_date, trip.end_date, interestWeights(view));
  if (!itinerary.some((d) => d.items.length)) return;
  await updateTrip(trip.id, { itinerary: itinerary as never });
  log.info({ tripId: trip.id }, "no plan from atlas after the nudges; saved the catalog draft");
  await announceFromJob(svc, trip.id, "itinerary", `site-plan-${trip.id}`);
}

/** For background jobs that changed a trip (research done, weather swap) and want its link posted. */
export async function announceFromJob(svc: Pick<AppServices, "cfg" | "post">, tripId: number, section: SiteSection, guid: string): Promise<void> {
  const trip = await tripById(tripId);
  const chat = trip && (await chatRow(trip.chat_id));
  if (!trip || !chat) return;
  try {
    const published = await publishTrip(svc.cfg, trip.id, chat, section);
    if (published) await svc.post(chat.id, guid, [linkAction(published.url, section)]);
  } catch (err) {
    log.warn({ err: (err as Error).message, tripId, section }, "trip page publish failed; retrying in the background");
    await requestAnnounce(svc.cfg, trip, section);
  }
}
