#!/usr/bin/env node
// Generates an animated SVG of the GitHub contribution graph with a wave
// pulse sweeping left -> right across the weeks.

import { writeFile, mkdir } from "node:fs/promises";
import { execSync } from "node:child_process";

const USERNAME = process.env.GH_USERNAME || "PedroRagazzo";

function getToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execSync("gh auth token", { encoding: "utf8" }).trim();
  } catch {
    throw new Error("No GitHub token found (set GH_TOKEN or GITHUB_TOKEN).");
  }
}

async function fetchContributions(username, token) {
  const query = `
    query($login: String!) {
      user(login: $login) {
        contributionsCollection {
          contributionCalendar {
            weeks {
              contributionDays {
                date
                weekday
                contributionCount
                color
              }
            }
          }
        }
      }
    }`;

  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "pulse-github-cont",
    },
    body: JSON.stringify({ query, variables: { login: username } }),
  });

  if (!res.ok) {
    throw new Error(`GraphQL request failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data.user.contributionsCollection.contributionCalendar.weeks;
}

// GitHub's own 5-level palettes.
const PALETTES = {
  light: ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"],
  dark: ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"],
};

// Outline color used to trace the wave through empty cells without
// brightening their fill.
const OUTLINE = {
  light: "#8c959f",
  dark: "#484f58",
};

// Peak of the crest per contribution level: busier days flare harder, so the
// wave traces the shape of the graph instead of flattening it.
const PEAKS = [
  { scale: 1.3, brightness: 1, saturate: 1 }, // empty cells: outline only
  { scale: 1.1, brightness: 1.45, saturate: 1.3 },
  { scale: 1.14, brightness: 1.6, saturate: 1.4 },
  { scale: 1.18, brightness: 1.75, saturate: 1.5 },
  { scale: 1.22, brightness: 1.9, saturate: 1.6 },
];

// Shape of one cell's pulse, in seconds from the moment the crest reaches it:
// a fast rise and a long decay, so the wave drags a fading tail behind its
// front instead of blinking on and off.
const CREST = 0.2;
const GLOW = 0.55;
const REST = 1.15;

// Fraction of the peak still left as the tail passes through GLOW. Brightness
// lingers longer than scale, which is what reads as afterglow.
const TAIL_SCALE = 0.2;
const TAIL_LIGHT = 0.45;

// Snappy on the way up, soft on the way down.
const EASE_UP = "cubic-bezier(.34,.9,.4,1)";
const EASE_DOWN = "cubic-bezier(.3,0,.55,1)";

function levelFromCount(count, maxCount) {
  if (count === 0) return 0;
  if (maxCount <= 4) return Math.min(4, count);
  const ratio = count / maxCount;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}

// The pulse is described in seconds but keyframes take percentages, so every
// stop is derived from the cycle length. Changing the sweep or the pause keeps
// the shape of the wave intact.
function buildKeyframes(totalDuration) {
  const pct = (t) => Number(((t / totalDuration) * 100).toFixed(3));
  const tail = (peak, keep) => Number((1 + (peak - 1) * keep).toFixed(3));

  const crest = pct(CREST);
  const glow = pct(GLOW);
  const rest = pct(REST);

  // Empty cells have nothing to brighten, so their crest is a ring that grows
  // out of the cell edge and fades back into it.
  const empty = `@keyframes wave-0 {
      0% { transform: scale(1); stroke-width: 0; animation-timing-function: ${EASE_UP}; }
      ${crest}% { transform: scale(${PEAKS[0].scale}); stroke-width: 2.4; animation-timing-function: ${EASE_DOWN}; }
      ${glow}% { transform: scale(${tail(PEAKS[0].scale, TAIL_SCALE)}); stroke-width: 0.9; animation-timing-function: ease-out; }
      ${rest}%, 100% { transform: scale(1); stroke-width: 0; }
    }`;

  const at = (scale, brightness, saturate) =>
    `transform: scale(${scale}); filter: brightness(${brightness}) saturate(${saturate});`;

  const filled = PEAKS.slice(1).map((peak, i) => {
    return `@keyframes wave-${i + 1} {
      0% { ${at(1, 1, 1)} animation-timing-function: ${EASE_UP}; }
      ${crest}% { ${at(peak.scale, peak.brightness, peak.saturate)} animation-timing-function: ${EASE_DOWN}; }
      ${glow}% { ${at(
        tail(peak.scale, TAIL_SCALE),
        tail(peak.brightness, TAIL_LIGHT),
        tail(peak.saturate, TAIL_LIGHT)
      )} animation-timing-function: ease-out; }
      ${rest}%, 100% { ${at(1, 1, 1)} }
    }`;
  });

  return [empty, ...filled].join("\n    ");
}

function buildSvg(weeks, theme) {
  const palette = PALETTES[theme];
  const outline = OUTLINE[theme];
  const cell = 11;
  const gap = 3;
  const step = cell + gap;
  const marginLeft = 4;
  const marginTop = 4;

  const cols = weeks.length;
  const width = marginLeft * 2 + cols * step - gap;
  const height = marginTop * 2 + 7 * step - gap;

  const maxCount = Math.max(
    1,
    ...weeks.flatMap((w) => w.contributionDays.map((d) => d.contributionCount))
  );

  // Total time (seconds) for the crest to cross the whole graph once.
  const sweepDuration = 4;
  // Pause between sweeps. Has to outlast the tail of the last column, or the
  // next sweep starts while the previous one is still fading out.
  const pause = 2;
  const totalDuration = sweepDuration + pause;
  const perColDelay = cols > 1 ? sweepDuration / (cols - 1) : 0;
  // Lower rows lag slightly, tilting the crest instead of sweeping it across
  // as a perfectly vertical bar.
  const perRowDelay = perColDelay * 0.35;

  let rects = "";
  weeks.forEach((week, colIndex) => {
    week.contributionDays.forEach((day) => {
      const level = levelFromCount(day.contributionCount, maxCount);
      const delay = (colIndex * perColDelay + day.weekday * perRowDelay).toFixed(3);
      const x = marginLeft + colIndex * step;
      const y = marginTop + day.weekday * step;
      rects += `<rect class="cell lvl-${level}" x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" ry="2" fill="${palette[level]}" style="animation-delay:${delay}s"><title>${day.date}: ${day.contributionCount} contributions</title></rect>\n`;
    });
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <style>
    .cell {
      transform-box: fill-box;
      transform-origin: center;
      animation-duration: ${totalDuration}s;
      animation-iteration-count: infinite;
      /* Timing lives in the keyframes, one easing per segment of the pulse. */
      animation-timing-function: linear;
    }
    .lvl-0 {
      animation-name: wave-0;
      stroke: ${outline};
      stroke-width: 0;
      vector-effect: non-scaling-stroke;
    }
    .lvl-1 { animation-name: wave-1; }
    .lvl-2 { animation-name: wave-2; }
    .lvl-3 { animation-name: wave-3; }
    .lvl-4 { animation-name: wave-4; }
    ${buildKeyframes(totalDuration)}
    @media (prefers-reduced-motion: reduce) {
      .cell { animation: none; }
    }
  </style>
  ${rects}
</svg>`;
}

async function main() {
  const token = getToken();
  const weeks = await fetchContributions(USERNAME, token);

  const svgLight = buildSvg(weeks, "light");
  const svgDark = buildSvg(weeks, "dark");

  await mkdir("dist", { recursive: true });
  await writeFile("dist/wave.svg", svgLight, "utf8");
  await writeFile("dist/wave-dark.svg", svgDark, "utf8");

  console.log(`Generated dist/wave.svg and dist/wave-dark.svg for ${USERNAME}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
