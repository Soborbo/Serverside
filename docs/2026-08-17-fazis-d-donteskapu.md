# Fázis D — a döntési kapu kritériuma ÁTÍRVA (2026-08-17)

A Fázis D eredeti döntési kapuja **`≥10 GRANTED-skip teljes attribúcióval`** volt.
Ez a kritérium **nem teljesíthető**, és a kapu határozatlan ideig nyitva maradna
egy olyan feltételen, aminek nincs alanya.

## Miért — a mérés, ami ezt eldöntötte

A „megmagyarázatlan GRANTED-skip" halmaz: azok az események, ahol az
`ad_allowed=1` (a látogató hozzájárult), a Meta mégis `skipped` lett, és a sor
bekerült a ledgerbe (tehát nem `not_expected` — azt az `isNotExpectedSkip`
szűrő kidobja).

Az elmúlt 60 nap TELJES listája:

| nap | site | db |
|---|---|---:|
| 2026-07-15 | lomtalan | 1 |
| 2026-07-16 | agykontroll | 1 |
| 2026-07-16 | lomtalan | 1 |
| 2026-07-17 | lomtalan | 1 |
| 2026-07-18 | agykontroll | 1 |
| 2026-07-18 | lomtalan | 3 |
| 2026-07-19 | lomtalan | 1 |
| 2026-07-20 | lomtalan | 2 |
| 2026-07-21 | lomtalan | 1 |

**Összesen 11 esemény, mind 2026-07-15 és 07-21 között. Azóta 27 nap: nulla.**

A kezdőnap — 2026-07-15 — pontosan a lomtalan-incidens napja. Ezek tehát nem
ismeretlen eredetű anomáliák, hanem a **már diagnosztizált és lezárt júliusi
config-vesztés maradéka** (`not_configured`), és a jelenség megszűnt, amikor a
lomtalan Meta-configja visszakerült.

Következmény: a `skip_reason` oszlop a JÖVŐBELI sorokat nevezi meg. Ha a
jelenség kihalt, a Fázis D nulla ilyen esetet fog gyűjteni.

## Az új kritérium

```
minimum 14 nap ÉS ≥500 GRANTED receipt (a mai rátán ≈26 nap), maximum 30 nap
  → a döntést a `source_consistent=0` arány és a NULL-forrás mintázat adja
  → a GRANTED-skip attribúció BÓNUSZ, ha egyáltalán lesz ilyen eset
```

Ez arra épül, amit **minden egyes event mér** — a betöltési verseny hipotézisére,
ami a Fázis D valódi tárgya —, nem a ritka anomáliákra.

## Amit ez NEM változtat

A Fázis D értéke nem csökken; csak a mérendő jelenség más, mint amit az eredeti
terv mondott.

És a védőlánc, ami pont ezt az incidens-osztályt fogná meg, **még mindig
inaktív a lomtalanon**: az `expected_platforms` hiányzik a painless /
beautyflow / lomtalan configjából. Amíg az nincs felírva, egy következő
config-vesztés ugyanígy csendben menne (`scripts/apply-kv-recon-config.sh`).
