// Writes the pull request comment from the summary that src/cli.js leaves in flagshots.json.
//
// This file only builds text: no network. test/comment.test.js covers it, and src/publish.js
// does the posting.

// The comment carries this hidden line, so the next run finds it and edits it in place
// instead of adding a new comment on every push.
export const MARKER = '<!-- flagshots -->';

// Text inside a Markdown table cell: a pipe would end the cell and a line break would end the row.
function cell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}

// summary:  the parsed flagshots.json
// options.images:  a Map from page slug to the image URL. A page with no URL (a fork's pull
//                  request, where the job can't write to the repo) points to the run's files.
// options.commit:  the commit the screenshots were taken from
// options.runUrl:  the link to the job log
export function commentBody(summary, { images = new Map(), commit, runUrl } = {}) {
  const lines = [MARKER, '### Flagshots', ''];

  const from = commit ? ` Screenshots from ${commit.slice(0, 7)}.` : '';
  lines.push(
    `Every state of each flag in Flagsmith (${summary.environment}), a row per flag. ` +
      `The first column is what visitors get today.${from}`,
    '',
  );

  for (const page of summary.pages) {
    lines.push(`#### ${page.name} \`${page.path}\``, '');
    const url = images.get(page.slug);
    if (url) {
      lines.push(`![${page.name} in each flag state](${url})`, '');
    } else {
      lines.push(`The grid for ${page.name} is in the \`flagshots\` files of this run${runUrl ? ` (${runUrl})` : ''}.`, '');
    }

    // A flag can render the same in every state on a page (it may only affect another page).
    // Saying so stops a reviewer hunting for a difference that isn't there.
    const unchanged = (page.rows ?? []).filter((r) => !r.changed).map((r) => `\`${r.flag}\``);
    if (unchanged.length) {
      lines.push(`No visible difference on ${page.name}: ${unchanged.join(', ')}.`, '');
    }
  }

  lines.push('<details><summary>Flags and states</summary>', '');
  lines.push('| Flag | Visitors get | Also rendered |', '| --- | --- | --- |');
  for (const flag of summary.flags) {
    const now = flag.states.find((s) => s.default);
    const others = flag.states.filter((s) => !s.default).map((s) => cell(s.label));
    lines.push(`| \`${flag.flag}\` | ${cell(now?.label ?? '')} | ${others.join(', ')} |`);
  }
  const example = summary.flags.flatMap((f) => f.states).find((s) => s.identity)?.identity;
  lines.push('');
  if (example) {
    lines.push(
      'Each shot loads the page as a Flagsmith identity with an override for one flag, ' +
        `such as \`${example}\`.`,
      '',
    );
  }
  lines.push('</details>', '');

  if (runUrl) lines.push(`[Job log](${runUrl})`, '');
  return `${lines.join('\n').trimEnd()}\n`;
}
