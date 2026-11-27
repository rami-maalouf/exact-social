# Exact Social

A native social post planner built with [Exact](https://github.com/expo/exact). The first slice is a queue of post drafts, a compose sheet, and drafts kept on the device.

Nothing in this slice schedules or publishes. A draft can name channels and carry a planned day and time; both are notes on the draft, and the screens say so. A planned day that has gone by is marked Past, never as sent.

## Run

The app uses the sibling `../expo-exact` checkout by path (`EXACT2` overrides it).

```sh
bun exact.mjs ios --run   # an iOS simulator
bun exact.mjs web         # the web dev loop
```

## Verify

```sh
bun exact.mjs verify       # web: tests, light and dark, two widths, largest text, relaunch
bun exact.mjs verify ios   # the same on a simulator, with UIKit's bars
```

## Layout

- `app.contract`: the view. `App` is the queue and owns the data; `Composer` is the sheet for a new draft or the row tapped.
- `app.ts`: the data module. It keeps drafts in `app:/data/drafts.json` and answers the queue grouped and ordered: drafts with no day first, then each planned day in turn.
- `channels.ts`: the channels a draft can name, and the seam for an account connection. `listChannels` answers a fixed local list today; a Postiz connection can answer connected accounts with the same fields (`id`, `name`, `limit`). A draft stores channel ids only.
- `app.test.contract`: the tests, driven by `testId` on every host.
- `lib/`, `tools/`, `research/`: the Postiz read adapter and the research brief. The UI does not import them yet.

## What the UI does not do yet

Attach media, connect an account, schedule, publish, or show sent posts. The compose sheet has no per-channel text or settings. The Mac's software keyboard setting hides the simulator keyboard in some captures; the layout under a keyboard was checked only where the capture showed it.
