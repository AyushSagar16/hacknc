# Atlas: the friend who actually books the trip

Every friend group has the same thread: "we should go somewhere," forty messages of maybes, and
then nothing. Planning dies in the group chat because nobody wants to be the one tracking who can
go when, who can't fly, who's vegetarian, and who can't spend $900 this month.

**Atlas lives in that group chat.** Add its number and it introduces itself, then it listens.

**It reads the conversation, not a form.** "Cancun is too pricey for me." "I can't fly after the
14th." "I'm vegetarian." Atlas pulls out each person's preferences and limits from normal texting,
keeps the exact words they came from, and builds a live picture of the group. When two people
want opposite things, it says so once, kindly, and suggests a way through.

**It knows what everyone can actually spend.** Each person's comfortable trip budget comes from
account data: paychecks in, recurring bills out, typical everyday spending, explained in three
plain lines. In this demo the accounts are Capital One sandbox profiles, and Atlas always says so.
Anyone can keep their budget private, and then Atlas only uses it pooled.

**It turns maybes into a plan.** Three destinations that fit everyone's dates, diets, budgets and
travel limits, each with a cost breakdown labeled live fare or estimate. Then a native iMessage
poll. When a majority votes, the trip is locked, with dates, a rough plan and booking links.

**It handles the money nobody wants to handle.** A payment plan timed to each person's paydays.
During the trip, "i paid 64 for dinner" is all it takes to log an expense. Disputes go to the
person who paid. At the end, settle-up uses the fewest possible transfers, and nothing moves until
the person paying confirms.

**It remembers, and it watches out.** Atlas remembers what everyone said weeks ago. If the
forecast for the trip changes, it speaks up with a concrete swap: "saturday flipped to rain, want
to swap the beach day for the food market tour?"

**And it knows when to be quiet.** Most messages in a group chat aren't for Atlas, and it can tell.
"Stay quiet" turns it off.

Under the hood:
- the language model only does language
- every dollar figure Atlas shows traces to a bank-API call or a labeled estimate
- a money guard blocks anything else from being sent
