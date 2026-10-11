# Atlas launch video

A ~94 second launch film for Atlas, made with [Remotion](https://www.remotion.dev) (React → MP4).
It uses the trip site's look (Frutiger Aero kept quiet: pale sky, frosted glass, one aqua accent;
see `web/app/globals.css`) with a few Y2K extras: glossy aero bubbles, sparkles, a perspective grid.

```bash
npm install
```

```bash
npm run dev
```

```bash
npx remotion render AtlasLaunch out/atlas-launch.mp4 --codec=h264 --crf=18
```

`npm run dev` opens Remotion Studio. `AtlasLaunch` is the full film. Each scene is also registered
on its own under **Scenes** so it can be previewed and edited separately.

There is also a bento marketing sheet (2400 × 2160 PNG) built from the same components:

```bash
npx remotion still BentoSheet out/atlas-bento.png --frame=119
```

And a 3:2 thumbnail (2400 × 1600):

```bash
npx remotion still Thumbnail out/atlas-thumbnail.png --frame=60
```

The latest renders of both images are kept in `marketing/`. The MP4 isn't committed; render it with the command above.

## Story

| Time | Scene | What it shows |
|---|---|---|
| 0:00 | Hook | The group chat every friend group has: 47 maybes, 0 bookings |
| 0:08 | Logo | The drop. "The friend who actually plans the trip." |
| 0:12 | Join | Maya adds Atlas's number; it introduces itself and asks to connect Capital One |
| 0:18 | Connect | The consent sheet → Capital One Nessie accounts, 3 months of transactions, the budget formula, private by default |
| 0:31 | Reads | Preferences pulled from normal texting (veto, diet, drive-only), and it stays quiet for banter |
| 0:41 | Options | Three priced options, a native iMessage poll, Cancún vetoed, Charleston locked |
| 0:51 | Stay | Travel plan (carpool + drive), stays, the townhouse booked onto the trip fund |
| 0:58 | Fund | The trip fund as its own Nessie account, filled by payday transfers, paying for the stay |
| 1:07 | Food | Food & activities picked into the itinerary on the trip page |
| 1:14 | Split | Splitwise-style expenses and the fewest-transfers settle-up, sent after confirm |
| 1:25 | Montage | Weather swaps, long memory, privacy, knowing when to be quiet |
| 1:28 | End | "Plan the trip. Split the bill. Stay friends." |

## Layout

- `src/chat/script.ts`: the whole group chat (messages, poll, links) and chapter timings. Change a
  chapter's length in `CHAPTERS` and everything after it moves.
- `src/chat/Phone.tsx`: the iPhone and Messages UI (status bar, Dynamic Island, group header,
  bubbles with tails, typing indicator, native poll, rich links, input bar that types Maya's messages).
- `src/scenes/ChatAct.tsx`: the phone stays on screen and swaps sides between chapters;
  `src/scenes/chat/*` are the chapter graphics beside it.
- `src/theme.ts`: colours and fonts (Nunito Sans like the site, JetBrains Mono, the system font in the phone).

## Audio

Everything is synthesized, so there's nothing to license: `python3 -I scripts/make-audio.py` (from
the repo root) writes the music (120 BPM, drop at 8.0 s, final hit at 88.5 s) and the sound effects
to `public/audio/`. Message sounds follow the chat script automatically.

`node scripts/stills.mjs AtlasLaunch 300 900 1500` renders single frames to `out/stills/` for a quick look.

Chat wording follows what Atlas really says (`src/agent`, `test/scenarios/*.chat`); people, places
and figures are mocked. Nessie account data is generated, as it is in the app.

## Photo credits

Destination photos in `public/images/` are from Wikimedia Commons, resized:

- `charleston.jpg`: [East Battery Street, Charleston](https://commons.wikimedia.org/wiki/File:East_Battery_Street_Charleston_Aug2010.jpg) by Chris Pruitt, CC BY-SA 3.0
- `savannah.jpg`: [Forsyth Park fountain](https://commons.wikimedia.org/wiki/File:Forsyth_fountain_2019.jpeg) by Seasider53, CC BY-SA 4.0
- `wilmington.jpg`: [Wrightsville Beach, North Carolina](https://commons.wikimedia.org/wiki/File:Wrightsville_Beach,_North_Carolina_(January_2023)_7_(cropped).jpg) by DiscoA340, CC BY-SA 4.0
