// The whiteboard: strokes drawn in the panel, shown on stream. Used by the overlay page and by the panel, so both
// draw a stroke the same way.
//
// A stroke: { id, color: "#rrggbb", width, erase?, points: [x0, y0, x1, y1, …] }.
//   points are fractions of the board (0–1 across, 0–1 down), so the panel's small canvas and the stream's big one
//   show the same picture; width is in thousandths of the board's width.
// An eraser stroke rubs out what is under it (it is not a stroke in the board's colour: the board may be see-through).

/** Draw a stroke's points from index `from` (in points, not numbers) on a 2D context of size w × h. */
function draw(ctx, w, h, s, from = 0) {
  const p = s.points, n = p.length / 2;
  if (!n) return;
  ctx.save();
  ctx.globalCompositeOperation = s.erase ? "destination-out" : "source-over";
  ctx.strokeStyle = ctx.fillStyle = s.erase ? "#000" : s.color;
  ctx.lineWidth = Math.max(1, (s.width / 1000) * w);
  ctx.lineCap = ctx.lineJoin = "round";
  const X = (i) => p[i * 2] * w, Y = (i) => p[i * 2 + 1] * h;
  if (n === 1) {                                  // a tap: a dot
    ctx.beginPath(); ctx.arc(X(0), Y(0), ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill();
  } else {
    const a = Math.max(0, from - 1);              // one point back, so the new piece joins what is there
    ctx.beginPath(); ctx.moveTo(X(a), Y(a));
    for (let i = a + 1; i < n; i++) ctx.lineTo(X(i), Y(i));
    ctx.stroke();
  }
  ctx.restore();
}

/** A board on a canvas. `set` replaces everything; `add` and `append` are a stroke starting and growing. */
export function makeBoard(canvas) {
  const ctx = canvas.getContext("2d");
  let strokes = [];
  const redraw = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of strokes) draw(ctx, canvas.width, canvas.height, s);
  };
  return {
    get strokes() { return strokes; },
    redraw,
    set(list) { strokes = (list ?? []).map((s) => ({ ...s, points: [...s.points] })); redraw(); },
    add(stroke) {
      if (strokes.some((s) => s.id === stroke.id)) return;
      const s = { ...stroke, points: [...stroke.points] };
      strokes.push(s);
      draw(ctx, canvas.width, canvas.height, s);
    },
    append(id, points) {
      const s = strokes.findLast((x) => x.id === id);
      if (!s) return;
      const from = s.points.length / 2;
      s.points.push(...points);
      draw(ctx, canvas.width, canvas.height, s, from);
    },
  };
}
