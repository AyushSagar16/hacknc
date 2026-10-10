# hacknc

## Just hack and see

No big plan, no perfect spec. Pick an idea, start building, and find out what happens.

- **Start small.** Get something running in the first hour, even if it's ugly.
- **Try things.** If you're not sure whether an approach works, build it and check.
- **Break stuff.** Mistakes show you what to do next.
- **Keep going.** Each version teaches you something the last one couldn't.

You learn by building, so just hack and see.

## Stack

A [Spectrum](https://photon.codes/docs/spectrum-ts) project. Wired with: imessage.

## Environment

The app reads `PROJECT_ID` and `PROJECT_SECRET` from `.env` (gitignored). If you clone this fresh, copy `.env.example` to `.env` and fill in the values from your project Settings on the [Photon dashboard](https://app.photon.codes).

## Run

```sh
npm install
npm run start   # or: npm run dev (restarts on file changes)
```

## Where to go next

- [Spectrum docs](https://photon.codes/docs/spectrum-ts)
- Edit `src/index.ts` to replace the echo loop with real agent logic.
- Add more providers from `spectrum-ts/providers/*`.
