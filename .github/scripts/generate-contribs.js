/**
 * Generates an SVG of repositories the TARGET_USER has contributed to
 * and injects an <img> block into README.md between markers.
 *
 * Writes .github/contribs.svg and updates README.md.
 *
 * Requires:
 *   - env.GITHUB_TOKEN (provided by Actions)
 *   - env.TARGET_USER (username to query)
 *   - env.MAX_REPOS (optional)
 */

const fs = require('fs');
const path = require('path');
const fetch = global.fetch || require('node-fetch');

const GITHUB_GRAPHQL = 'https://api.github.com/graphql';
const token = process.env.GITHUB_TOKEN;
const username = process.env.TARGET_USER || process.env.GITHUB_ACTOR;
const maxRepos = parseInt(process.env.MAX_REPOS || '24', 10);

if (!token) {
  console.error('GITHUB_TOKEN is required in env');
  process.exit(1);
}

if (!username) {
  console.error('TARGET_USER or GITHUB_ACTOR must be set');
  process.exit(1);
}

async function fetchRepos(user, limit) {
  const query = `
    query($login: String!, $limit: Int!) {
      user(login: $login) {
        repositoriesContributedTo(first: $limit, includeUserRepositories: false, contributionTypes: [COMMIT, PULL_REQUEST, ISSUE]) {
          nodes {
            name
            url
            description
            owner {
              login
              avatarUrl
            }
          }
        }
      }
    }
  `;

  const res = await fetch(GITHUB_GRAPHQL, {
    method: 'POST',
    headers: {
      Authorization: `bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'github-actions/contribs-generator'
    },
    body: JSON.stringify({ query, variables: { login: user, limit } })
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GraphQL request failed: ${res.status} ${res.statusText}\n${t}`);
  }

  const data = await res.json();
  if (data.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(data.errors, null, 2)}`);
  }

  return data.data.user.repositoriesContributedTo.nodes;
}

function escapeXml(s = '') {
  return s.replace(/[&<>'"]/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&apos;', '"': '&quot;' })[c];
  });
}

function buildSvg(repos) {
  // Layout settings
  const iconSize = 64;
  const padding = 12;
  const gap = 16;
  const cols = Math.max(1, Math.min(repos.length, 8)); // max 8 per row
  const rows = Math.ceil(repos.length / cols);
  const width = padding * 2 + cols * iconSize + (cols - 1) * gap;
  const height = padding * 2 + rows * iconSize + (rows - 1) * gap;

  // Start SVG
  let svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"\n     xmlns:xlink="http://www.w3.org/1999/xlink"\n     width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n  <style>\n    .repo-image { rx: 12; ry: 12; }\n    .repo-link { cursor: pointer; }\n  </style>\n`;

  // For each repo render an <a> with embedded <image>
  repos.forEach((r, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const x = padding + col * (iconSize + gap);
    const y = padding + row * (iconSize + gap);
    const avatar = r.owner.avatarUrl + '&s=256'; // request larger size
    const title = escapeXml(`${r.owner.login}/${r.name}${r.description ? ' — ' + r.description : ''}`);

    svg += `\n  <a xlink:href="${escapeXml(r.url)}" target="_blank" rel="noopener noreferrer">\n    <g transform="translate(${x}, ${y})" class="repo-link">\n      <title>${title}</title>\n      <clipPath id="cp${idx}">\n        <rect width="${iconSize}" height="${iconSize}" rx="12" ry="12"/>\n      </clipPath>\n      <image x="0" y="0" width="${iconSize}" height="${iconSize}" xlink:href="${escapeXml(avatar)}" clip-path="url(#cp${idx})" />\n      <!-- subtle border -->\n      <rect x="0" y="0" width="${iconSize}" height="${iconSize}" rx="12" ry="12" fill="none" stroke="#e6e6e6" />\n    </g>\n  </a>\n`;
  });

  svg += `</svg>\n`;
  return svg;
}

function injectIntoReadme(svgRelativePath) {
  const readmePath = path.join(process.cwd(), 'README.md');
  let content = fs.readFileSync(readmePath, 'utf8');

  const startMarker = '<!-- CONTRIBUTIONS:START -->';
  const endMarker = '<!-- CONTRIBUTIONS:END -->';

  const startIndex = content.indexOf(startMarker);
  const endIndex = content.indexOf(endMarker);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    console.warn('Markers not found in README.md. Please add these markers:');
    console.warn(startMarker);
    console.warn(endMarker);
    console.warn('Skipping README injection.');
    return false;
  }

  const injection = `\n<p align="center">\n  <a href="https://github.com/${username}" target="_blank" rel="noopener noreferrer">\n    <img src="${svgRelativePath}" alt="Repositories ${username} contributed to" />\n  </a>\n</p>\n`.trim();

  const before = content.slice(0, startIndex + startMarker.length);
  const after = content.slice(endIndex);

  const newContent = `${before}\n\n${injection}\n\n${after}`;
  if (newContent !== content) {
    fs.writeFileSync(readmePath, newContent, 'utf8');
    return true;
  }
  return false;
}

(async () => {
  try {
    console.log(`Fetching up to ${maxRepos} repositories contributed to by ${username}`);
    const repos = await fetchRepos(username, maxRepos);
    if (!repos || repos.length === 0) {
      console.log('No contributed repositories found. Skipping SVG generation.');
      process.exit(0);
    }

    const svg = buildSvg(repos);
    const svgPath = path.join(process.cwd(), '.github', 'contribs.svg');
    fs.mkdirSync(path.dirname(svgPath), { recursive: true });
    fs.writeFileSync(svgPath, svg, 'utf8');
    console.log(`Wrote ${svgPath}`);

    // Inject into README.md between markers. Link to .github/contribs.svg
    const changedReadme = injectIntoReadme('./.github/contribs.svg');

    // stage files for commit if in a git repo
    try {
      const { execSync } = require('child_process');
      execSync(`git add ${svgPath} README.md`, { stdio: 'inherit' });
    } catch (e) {
      // ignore if not a git repo or failure to add
    }

    console.log('Done.');
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
})();
