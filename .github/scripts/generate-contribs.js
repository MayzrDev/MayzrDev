/**
 * Generates a gallery of repository avatars contributed to by TARGET_USER via PRs only,
 * and injects it directly into README.md.
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
const PLACEHOLDER_AVATAR = 'https://avatars.githubusercontent.com/u/9919?s=64&v=4'; // fallback

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

function escapeHtml(s = '') {
  return s.replace(/[&<>'"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&apos;', '"': '&quot;' })[c]
  );
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

  // Build gallery using direct avatar URLs
  const injection = '\n<p align="center">\n' +
    repos.map(r => {
      const avatar = r.avatarUrl || r.owner.avatarUrl || PLACEHOLDER_AVATAR;
      const title = escapeHtml(`${r.owner.login}/${r.name}${r.description ? ' — ' + r.description : ''}`);
      const prUrl = `${r.url}/pulls?q=is:pr+author:${encodeURIComponent(username)}`;
      return `<a href="${prUrl}" target="_blank" rel="noopener noreferrer">
  <img src="${avatar}&s=64" alt="${title}" width="64" height="64" style="margin:4px;" />
</a>`;
    }).join('\n') +
    '\n</p>\n';

  const before = content.slice(0, startIndex + startMarker.length);
  const after = content.slice(endIndex);
  const newContent = `${before}\n${injection}\n${after}`;
  fs.writeFileSync(readmePath, newContent, 'utf8');
  console.log('Injected repo icons gallery directly into README.md');
}

(async () => {
  try {
    console.log(`Fetching up to ${maxRepos} repositories contributed to by ${username} via PRs`);
    const repos = await fetchRepos(username, maxRepos);

    if (!repos || repos.length === 0) {
      console.log('No contributed repositories found (excluding own repos).');
      process.exit(0);
    }

    injectIntoReadme(repos);
    console.log('Done.');
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
})();
