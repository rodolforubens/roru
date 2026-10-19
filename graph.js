// Computes and draws the commit graph (lanes) row by row.

export const LANE_W = 14;
export const ROW_H = 26;

const COLORS = ['#7aa2f7', '#9ece6a', '#f7768e', '#e0af68', '#bb9af7', '#2ac3de', '#ff9e64', '#73daca', '#c0caf5', '#db4b4b'];
export const laneColor = i => COLORS[i % COLORS.length];

/**
 * For each commit (in log order) returns:
 *  { col, width, segs: [{ kind: 'pass'|'in'|'out', from, to, color }] }
 * 'pass' = vertical line crossing the whole row
 * 'in'   = from the top (column from) to the center (column to)
 * 'out'  = from the center (column from) to the bottom (column to)
 */
export function computeGraph(commits) {
  const lanes = []; // hash expected in each column
  const rows = [];

  for (const c of commits) {
    let col = lanes.indexOf(c.sha);
    const hadIncoming = col !== -1;
    if (col === -1) {
      col = lanes.indexOf(null);
      if (col === -1) col = lanes.length;
      lanes[col] = c.sha;
    }

    const segs = [];
    const before = lanes.slice();

    // Lanes that converge into this commit
    for (let i = 0; i < before.length; i++) {
      if (before[i] == null || i === col) continue;
      if (before[i] === c.sha) {
        segs.push({ kind: 'in', from: i, to: col, color: laneColor(i) });
        lanes[i] = null;
      }
    }
    if (hadIncoming) segs.push({ kind: 'in', from: col, to: col, color: laneColor(col) });

    // Parents
    lanes[col] = c.parents[0] ?? null;
    if (c.parents.length) segs.push({ kind: 'out', from: col, to: col, color: laneColor(col) });
    for (let p = 1; p < c.parents.length; p++) {
      const ph = c.parents[p];
      let k = lanes.indexOf(ph);
      if (k === -1) {
        k = lanes.indexOf(null);
        if (k === -1) k = lanes.length;
        lanes[k] = ph;
      }
      segs.push({ kind: 'out', from: col, to: k, color: laneColor(k) });
    }

    // Lines that just pass through
    for (let i = 0; i < before.length; i++) {
      if (i === col || before[i] == null || before[i] === c.sha) continue;
      segs.push({ kind: 'pass', from: i, to: i, color: laneColor(i) });
    }

    while (lanes.length && lanes[lanes.length - 1] == null) lanes.pop();
    const width = Math.max(before.length, lanes.length, col + 1);
    rows.push({ col, width, segs });
  }
  return rows;
}

const x = i => i * LANE_W + LANE_W / 2 + 4;

export function graphSvg(row, commit, isHead, cols) {
  const w = cols * LANE_W + 8;
  const h = ROW_H, cy = h / 2;
  let paths = '';
  for (const s of row.segs) {
    let d;
    if (s.kind === 'pass') d = `M${x(s.from)} 0V${h}`;
    else if (s.kind === 'in') d = s.from === s.to ? `M${x(s.from)} 0V${cy}` : `M${x(s.from)} 0C${x(s.from)} ${cy} ${x(s.to)} ${cy * 0.4} ${x(s.to)} ${cy}`;
    else d = s.from === s.to ? `M${x(s.from)} ${cy}V${h}` : `M${x(s.from)} ${cy}C${x(s.from)} ${h - cy * 0.4} ${x(s.to)} ${cy} ${x(s.to)} ${h}`;
    paths += `<path d="${d}" stroke="${s.color}"/>`;
  }
  const cx = x(row.col), color = laneColor(row.col);
  const merge = commit.parents.length > 1;
  let dot;
  if (isHead) dot = `<circle cx="${cx}" cy="${cy}" r="5.5" fill="var(--bg)" stroke="${color}" stroke-width="2.5"/><circle cx="${cx}" cy="${cy}" r="2" fill="${color}"/>`;
  else if (merge) dot = `<circle cx="${cx}" cy="${cy}" r="4" fill="var(--bg)" stroke="${color}" stroke-width="2"/>`;
  else dot = `<circle cx="${cx}" cy="${cy}" r="4.5" fill="${color}"/>`;
  return `<svg class="graph" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><g fill="none" stroke-width="2" stroke-linecap="round">${paths}</g>${dot}</svg>`;
}
