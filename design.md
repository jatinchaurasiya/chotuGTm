# Design — chotu dashboard

A locked design system for this app. Every page redesign reads this file before
emitting code. Do not regenerate per page — extend or amend this file when the
system needs to grow.

## Genre

modern-minimal (Stripe / ElevenLabs school: quiet paper, hard ink, one loud accent).
App surface, not marketing — function carries the page, zero enrichment.

## Macrostructure family

- Marketing pages: n/a (this app ships no marketing routes).
- App pages: **Workbench** — small functional heads, ledger/table body, sticky action
  row per unit. Queue tab = full-bleed ledger rows (one opportunity per row-block).
  Scorecard tab = stat-led strip on top, spec-sheet tables below. Ops tab = two
  stacked slabs (Doctor kv-list, Failed-jobs table).
- Content pages: n/a.

## Theme

Brutal on modern-minimal paper. Heavy 2px ink rules, square corners, oversized
solid fills for primary actions only, marquee status footer. No shadows, no
rounded corners, no gradients, no imagery.

- `--color-paper`      oklch(97% 0.008 75)
- `--color-paper-2`    oklch(93.5% 0.010 75)
- `--color-ink`        oklch(20% 0.010 75)
- `--color-ink-2`      oklch(34% 0.012 75)
- `--color-rule`       oklch(80% 0.010 75)
- `--color-muted`      oklch(44% 0.012 75)
- `--color-accent`     oklch(63% 0.210 47)  /* safety-orange, <=5% viewport */
- `--color-accent-ink` oklch(22% 0.020 50)  /* dark ink on accent, >=4.5:1 */
- `--color-focus`      oklch(45% 0.180 45)
- `--color-good`       oklch(45% 0.150 150)
- `--color-warn`       oklch(48% 0.130 80)
- `--color-bad`        oklch(50% 0.200 25)

## Typography

- Display: "Archivo Black" (Google Fonts, 400 only), all-caps, line-height 1.04,
  tracking -0.01em. Wordmark, tab titles, stat figures, marquee.
- Body: system stack (`system-ui, -apple-system, "Segoe UI", sans-serif`), 400/600 only.
- Mono/labels: `ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace` — kickers,
  pills, table headers, code, footer meta. (3 families max; mono is the outlier and
  stays in ≤2 roles: labels + data.)
- Display tracking: -0.01em. Type scale anchor: `--text-display: clamp(2.75rem, 5vw + 1rem, 5.25rem)`.
- Italic headings banned. No heading or display type is ever italic.

## Spacing

4-point named scale only (every step a multiple of 4px). Pages must use named
tokens (`var(--space-md)`), never raw values.

```css
--space-2xs: 0.25rem;  /* 4px */
--space-xs:  0.5rem;   /* 8px */
--space-sm:  0.75rem;  /* 12px */
--space-md:  1rem;     /* 16px */
--space-lg:  1.5rem;   /* 24px */
--space-xl:  2.5rem;   /* 40px */
--space-2xl: 4rem;     /* 64px */
--space-3xl: 6rem;     /* 96px */
```

## Motion

- Easings: `--ease-out: cubic-bezier(0.16, 1, 0.3, 1)` (reserved; almost nothing moves).
- Reveal pattern: **NONE** — everything renders instantly. Reduced-motion passes trivially.
- Sole motion on the page: Ft8 marquee footer track (`32s linear infinite`,
  `translateX(0 → -50%)` only; `prefers-reduced-motion: reduce` → animation none).

## Microinteractions stance

- Silent success everywhere (copy/register/refresh show inline status text only;
  celebratory toasts never).
- Hover inside `@media (hover: hover)` only; state changes to `background-color` /
  `border-color` / `color` — never `transition: all`, never hover-scale, never
  width/height/top/left animation.
- Focus rings appear instantly (`:focus-visible`, 2px solid focus colour, 2px offset).
- Inputs + buttons share 44px height and 1px borders in every state (no border-width shifts).
- Clickable text never wraps (`white-space: nowrap` on all buttons/links/tabs).

## CTA voice

- Primary: oversized solid — ink fill, paper text, square, 44px floor, generous
  padding (`--space-sm --space-lg`), uppercase mono label. Used for: copy, register
  publish, retry.
- Secondary: outlined — transparent fill, 1px ink/rule border, same 44px height.
  Used for: tabs, platform sub-tabs, reload, workspace select.
- Active tab is the one accent fill on the page (accent bg + accent-ink text).

## Per-page allowances

- Queue tab MAY use full-bleed ledger rows (2px ink rule separators, accent bleed
  strip 8px above the section head). No cards-in-cards: row slab carries a 2px
  outer border; inner content blocks use background tint, never borders.
- Scorecard tab MAY use the stat-led strip (one oversized figure + qualifier) and
  tabular spec-sheet tables (row rules only, horizontal scroll inside `.tablewrap`).
- Ops tab MUST stay two plain slabs (kv list + table); no stat strip, no marquee.
- App pages MUST NOT use enrichment — no illustration, no demo chrome, no ornament.
- Copy stays honest: real empty-states only ("no data yet", "no attribution rows
  yet", "no matrix rows yet", "no failed jobs", "nothing queued — run discover
  first"). Zero invented metrics.

## What pages MUST share

- The wordmark (Archivo Black CHOTU, overlapping oversized slab variant in header).
- The accent colour and its placement (active tab + 8px bleed strip, ≤5% per viewport).
- The display + body + mono fonts.
- The CTA voice (square, 44px, solid-primary / outline-secondary).
- Section heading rhythm (mono kicker stacked ABOVE display title — never beside it).

## What pages MAY differ on

- Bleed-strip treatment per tab (queue: accent strip; scorecard: ink strip;
  ops: accent strip) — colour edge is the divider.
- Ledger rows (queue) vs stat-strip + tables (scorecard) vs plain slabs (ops).
- Nothing else. Pages that drift from this file are slop.

## Exports

### tokens.css

```css
:root {
  --color-paper:      oklch(97% 0.008 75);
  --color-paper-2:    oklch(93.5% 0.010 75);
  --color-ink:        oklch(20% 0.010 75);
  --color-ink-2:      oklch(34% 0.012 75);
  --color-rule:       oklch(80% 0.010 75);
  --color-muted:      oklch(44% 0.012 75);
  --color-accent:     oklch(63% 0.210 47);
  --color-accent-ink: oklch(22% 0.020 50);
  --color-focus:      oklch(45% 0.180 45);
  --color-good:       oklch(45% 0.150 150);
  --color-warn:       oklch(48% 0.130 80);
  --color-bad:        oklch(50% 0.200 25);

  --font-display: "Archivo Black", "Arial Black", sans-serif;
  --font-body:    system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono:    ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace;

  --space-2xs: 0.25rem;  --space-xs: 0.5rem;  --space-sm: 0.75rem;
  --space-md: 1rem;      --space-lg: 1.5rem;  --space-xl: 2.5rem;
  --space-2xl: 4rem;     --space-3xl: 6rem;

  --text-xs: 0.75rem;  --text-sm: 0.875rem;  --text-base: 1rem;
  --text-md: 1.25rem;  --text-lg: 1.5625rem; --text-xl: 1.9531rem;
  --text-2xl: 2.4414rem;
  --text-display: clamp(2.75rem, 5vw + 1rem, 5.25rem);
  --text-giant: clamp(4rem, 18vw, 11rem);

  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --dur-fast: 180ms;  --dur-base: 240ms;

  --radius-card: 0;  --radius-pill: 0;  --radius-input: 0;
}
```

### Tailwind v4 `@theme`

```css
@theme {
  --color-paper:   oklch(97% 0.008 75);
  --color-ink:     oklch(20% 0.010 75);
  --color-accent:  oklch(63% 0.210 47);
  --font-display:  "Archivo Black", sans-serif;
  --font-body:     system-ui, sans-serif;
  --spacing-md:    1rem;
  --text-md:       1.25rem;
  --ease-out:      cubic-bezier(0.16, 1, 0.3, 1);
}
```

### DTCG `tokens.json`

```json
{
  "color": {
    "paper":      { "$value": "oklch(97% 0.008 75)",  "$type": "color" },
    "ink":        { "$value": "oklch(20% 0.010 75)",   "$type": "color" },
    "accent":     { "$value": "oklch(63% 0.210 47)",   "$type": "color" },
    "accentInk":  { "$value": "oklch(22% 0.020 50)",   "$type": "color" }
  },
  "font": {
    "display": { "$value": "Archivo Black", "$type": "fontFamily" },
    "body":    { "$value": "system-ui",     "$type": "fontFamily" }
  },
  "space": {
    "md": { "$value": "1rem", "$type": "dimension" }
  }
}
```

### shadcn/ui CSS variables

```css
:root {
  --background:         97% 0.008 75;    /* paper */
  --foreground:         20% 0.010 75;    /* ink */
  --primary:            63% 0.210 47;    /* accent */
  --primary-foreground: 22% 0.020 50;    /* accent-ink */
  --muted:              80% 0.010 75;    /* rule */
  --muted-foreground:   44% 0.012 75;    /* muted */
  --border:             80% 0.010 75;    /* rule */
  --input:              80% 0.010 75;    /* rule */
  --ring:               45% 0.180 45;    /* focus */
  --radius:             0;
}
```
