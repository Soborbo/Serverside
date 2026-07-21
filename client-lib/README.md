# client-lib — TÖRÖLVE (F2-2), lásd a kanonikus package-et

A régi flat Sprint-9 template (`worker-tracking.ts` + `uuid.ts`) **superseded**.

A kanonikus Astro kliens-tracking lib mostantól a **`soborbo-tracking` package**:
- repo: **Soborbo/claudeskills**, `soborbo-tracking/` (`lib/` + `components/`, v5.x —
  `config`, `consent`, `event-contract`, `events`, `gateway` [= dispatch],
  `observability`, `persistence`, `uuid` + `TrackedForm.astro`/`Tracking.astro`).
- telepítés: a package `INSTALL.md` / `SKILL.md`-je szerint.
- a **beautyflow** ezt vendorolja (`tracking-kit/`); lomtalan/skinlab a `src/lib/tracking/`
  modult használja.

Új site bekötésekor **onnan** indulj, ne ebből a mappából. A backend event-szerződés
kanonikus otthona ettől FÜGGETLENÜL a Serverside (`src/events.json`, lásd
`src/events.contract.json`) — ne keverd a kettőt.
