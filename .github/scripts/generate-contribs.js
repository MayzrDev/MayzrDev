/**
 * Generates individual SVGs for repositories the TARGET_USER has contributed to via PRs only
 * (excluding repos they own), saves them in .github/contribs/<repo>.svg,
 * and injects them directly into README.md between markers.
 *
 * Requires:
 *   - env.GITHUB_TOKEN
 *   - env.TARGET_USER
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
        repositoriesContributedTo(first: $limit, contributionTypes: [PULL_REQUEST]) {
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

  // filter out repos owned by the user
  return data.data.user.repositoriesContributedTo.nodes.filter(r => r.owner.login !== user);
}

function escapeXml(s = '') {
  return s.replace(/[&<>'"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&apos;', '"': '&quot;' })[c]
  );
}

function buildSvg(repo) {
  const size = 128;
  const padding = 16;
  const title = escapeXml(`${repo.owner.login}/${repo.name}${repo.description ? ' — ' + repo.description : ''}`);
  const avatar = repo.owner.avatarUrl + '&s=256';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:xlink="http://www.w3.org/1999/xlink"
     width="${size + padding * 2}" height="${size + padding * 2}"
     viewBox="0 0 ${size + padding * 2} ${size + padding * 2}">
  <a xlink:href="${escapeXml(repo.url)}" target="_blank" rel="noopener noreferrer">
    <g transform="translate(${padding}, ${padding})">
      <title>${title}</title>
      <clipPath id="cp">
        <rect width="${size}" height="${size}" rx="16" ry="16"/>
      </clipPath>
      <image x="0" y="0" width="${size}" height="${size}" xlink:href="${escapeXml(avatar)}" clip-path="url(#cp)" />
      <rect x="0" y="0" width="${size}" height="${size}" rx="16" ry="16" fill="none" stroke="#e6e6e6" />
    </g>
  </a>
</svg>`;
}

function injectIntoReadme(repos) {
  const readmePath = path.join(process.cwd(), 'README.md');
  if (!fs.existsSync(readmePath)) return;

  let content = fs.readFileSync(readmePath, 'utf8');

  const startMarker = '<!-- CONTRIBUTIONS:START -->';
  const endMarker = '<!-- CONTRIBUTIONS:END -->';
  const startIndex = content.indexOf(startMarker);
  const endIndex = content.indexOf(endMarker);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    console.warn('Markers not found in README.md.');
    return;
  }

  // Read all SVGs and embed them inline
  const injection = '\n<p align="center">\n' +
    repos.map(r => {
      const safeName = r.name.replace(/[^a-z0-9-_]/gi, '_');
      const svgPath = path.join(process.cwd(), '.github', 'contribs', `${safeName}.svg`);
      if (fs.existsSync(svgPath)) {
        const svgContent = fs.readFileSync(svgPath, 'utf8');
        return `<a href="${r.url}" target="_blank" rel="noopener noreferrer">\n${svgContent}\n</a>`;
      }
      return '';
    }).join('\n') +
    '\n</p>\n';

  const before = content.slice(0, startIndex + startMarker.length);
  const after = content.slice(endIndex);
  const newContent = `${before}\n${injection}\n${after}`;
  fs.writeFileSync(readmePath, newContent, 'utf8');
  console.log('Injected SVG icons into README.md');
}

(async () => {
  try {
    console.log(`Fetching up to ${maxRepos} repositories contributed to by ${username} via PRs`);
    const repos = await fetchRepos(username, maxRepos);

    if (!repos || repos.length === 0) {
      console.log('No contributed repositories found (excluding own repos).');
      process.exit(0);
    }

    const contribDir = path.join(process.cwd(), '.github', 'contribs');
    fs.mkdirSync(contribDir, { recursive: true });

    for (const repo of repos) {
      const svg = buildSvg(repo);
      const safeName = repo.name.replace(/[^a-z0-9-_]/gi, '_');
      const svgPath = path.join(contribDir, `${safeName}.svg`);
      fs.writeFileSync(svgPath, svg, 'utf8');
      console.log(`Wrote ${svgPath}`);
    }

    injectIntoReadme(repos);
    console.log('Done.');
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
})();
