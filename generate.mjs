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

function levelFromCount(count, maxCount) {
  if (count === 0) return 0;
  if (maxCount <= 4) return Math.min(4, count);
  const ratio = count / maxCount;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}

function buildSvg(weeks, theme) {
  const palette = PALETTES[theme];
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

  // Total time (seconds) for the wave to cross the whole graph once.
  const sweepDuration = 3.2;
  // Pause between sweeps.
  const pause = 2.2;
  const totalDuration = sweepDuration + pause;
  const perColDelay = cols > 1 ? sweepDuration / (cols - 1) : 0;

  let rects = "";
  weeks.forEach((week, colIndex) => {
    const delay = (colIndex * perColDelay).toFixed(3);
    week.contributionDays.forEach((day) => {
      const level = levelFromCount(day.contributionCount, maxCount);
      const fill = palette[level];
      const x = marginLeft + colIndex * step;
      const y = marginTop + day.weekday * step;
      const cls = level === 0 ? "cell cell-empty" : "cell";
      rects += `<rect class="${cls}" x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" ry="2" fill="${fill}" style="animation-delay:${delay}s"><title>${day.date}: ${day.contributionCount} contributions</title></rect>\n`;
    });
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <style>
    .cell {
      transform-box: fill-box;
      transform-origin: center;
      animation: wave-pulse ${totalDuration}s ease-in-out infinite;
    }
    .cell-empty { animation: none; }
    @keyframes wave-pulse {
      0% { filter: brightness(1) saturate(1); transform: scale(1); }
      6% { filter: brightness(1.9) saturate(1.6); transform: scale(1.18); }
      14% { filter: brightness(1) saturate(1); transform: scale(1); }
      100% { filter: brightness(1) saturate(1); transform: scale(1); }
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
