/**
 * The admin pages' shared stylesheet (panel.ts, calls-page.ts): one look, one
 * place to change it. Plain CSS, inlined into each page's <style>.
 */
export const ADMIN_STYLE = String.raw`  :root {
    --bg: #14110f; --panel: #1d1916; --line: #2e2823; --ink: #efe7dd;
    --dim: #a89a8c; --accent: #e0a96d; --good: #7fb389; --bad: #d98a7a;
    --radius: 12px;
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
    padding: 20px; max-width: 980px; margin-inline: auto;
  }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: .3px;
       display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  h1 .dot { color: var(--accent); }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 1px;
       color: var(--dim); margin: 22px 0 10px; font-weight: 600;
       scroll-margin-top: 16px;
       display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  /* Control clusters that sit at the right edge of a heading and drop onto
     their own line when the viewport is too narrow to share it. */
  .controls { margin-left: auto; display: flex; gap: 8px; align-items: center;
              flex-wrap: wrap; text-transform: none; letter-spacing: normal; }
  h2 .controls select { width: auto; padding: 3px 7px; font-size: 13px; }
  h2 .controls button { padding: 3px 9px; font-size: 13px; }
  h2 .controls .check { font-size: 13px; white-space: nowrap; font-weight: 400; }
  .pager { display: flex; justify-content: flex-end; align-items: center; gap: 10px; margin-top: 10px; }
  /* Quick nav - fixed in the left gutter, only when the viewport is wide
     enough to fit it beside the centered 980px column. */
  #quickNav { display: none; }
  @media (min-width: 1360px) {
    #quickNav { display: block; position: fixed; top: 34px;
                left: calc(50vw - 490px - 176px); width: 150px; font-size: 15px; }
    #quickNav a { display: block; color: var(--dim); text-decoration: none;
                  padding: 3px 0 3px 10px; border-left: 2px solid var(--line); }
    #quickNav a:hover { color: var(--accent); border-left-color: var(--accent); }
  }
  #quickNav.hidden { display: none; }
  .sub { color: var(--dim); font-size: 14px; margin: 0 0 14px; }
  /* Explainer paragraphs are toggled as a group - hidden by default, revealed
     by the "Show explanations" button in the header. */
  body.hide-help .help-text { display: none; }
  /* Compact view (the default): the key cards and tables only. Anything
     marked .detail - the long tail of per-hour cards, itemized sits, cache
     breakdown, distributions, daily table - waits behind the header's
     "Full view" button, so each section fits about a screen. */
  body.compact .detail { display: none; }
  .card { background: var(--panel); border: 1px solid var(--line);
          border-radius: var(--radius); padding: 12px 14px; margin-bottom: 10px; }
  /* A stat grid directly before a card used to touch it. */
  .grid { margin-bottom: 10px; }
  label { display: block; font-size: 14px; color: var(--dim); margin-bottom: 5px; }
  input, textarea {
    width: 100%; padding: 9px 11px; background: #100d0b; color: var(--ink);
    border: 1px solid var(--line); border-radius: 8px; font: inherit;
  }
  textarea { resize: vertical; min-height: 60px; }
  input:focus, textarea:focus { outline: none; border-color: var(--accent); }
  .check { display: flex; align-items: center; gap: 7px; cursor: pointer; font-size: 14px; }
  .check input { width: auto; }
  button.xs { padding: 4px 10px; font-size: 13px; }
  button {
    padding: 8px 14px; background: var(--accent); color: #1a1208; border: none;
    border-radius: 8px; font: inherit; font-weight: 600; cursor: pointer;
  }
  button.ghost { background: transparent; color: var(--ink); border: 1px solid var(--line); }
  button:disabled { opacity: .5; cursor: default; }
  button:hover:not(:disabled) { filter: brightness(1.08); }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
  .row > div { flex: 1; min-width: 140px; }
  .row > button { flex: 0 0 auto; }
  table { width: 100%; border-collapse: collapse; font-size: 15px; }
  /* Wide tables scroll inside their card instead of spilling past its edge. */
  .table-wrap { overflow-x: auto; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  /* Headers stay on one line; a wide table scrolls in its .table-wrap rather
     than stacking every header word (the 13-column sits table ran 7 rows tall). */
  th { white-space: nowrap; }
  /* Long free-text cells (incident detail) clip with the full text on hover. */
  td.clip { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Long unbreakable values (emails) give up width first; the action column
     never wraps and takes only what its button needs. */
  td.wrap { overflow-wrap: anywhere; }
  th.act, td.act { width: 1%; white-space: nowrap; text-align: right; }
  th { color: var(--dim); font-weight: 600; font-size: 13px;
       text-transform: uppercase; letter-spacing: .5px; }
  tbody tr { cursor: pointer; }
  tbody tr:hover { background: #221d19; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px;
          font-size: 13px; font-weight: 600; }
  /* A row of pills standing in for a stat grid (incident kinds). */
  .pills { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 10px; }
  .pills .lead { font-weight: 700; margin-right: 4px; }
  .pills .lead.bad { color: var(--bad); }
  .pill.warn { background: rgba(217,138,122,.16); color: var(--bad); }
  .pill.paid { background: rgba(127,179,137,.18); color: var(--good); }
  .pill.free { background: rgba(168,154,140,.16); color: var(--dim); }
  .prov { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 13px;
          border: 1px solid var(--line); color: var(--dim); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
  .stat { background: #100d0b; border: 1px solid var(--line); border-radius: 8px; padding: 8px 11px; min-width: 0; }
  /* One line per label, clipped with the full label on hover, so a card is
     always two lines tall and the grid rows line up. */
  .stat .k { font-size: 12px; color: var(--dim); text-transform: uppercase; letter-spacing: .4px;
             white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .stat .v { font-size: 17px; font-weight: 700; margin-top: 2px; font-variant-numeric: tabular-nums;
             overflow-wrap: anywhere; }
  .stat .v.warn { color: var(--bad); }
  .msg { font-size: 14px; margin-top: 8px; min-height: 18px; }
  .msg.ok { color: var(--good); }
  .msg.err { color: var(--bad); }
  .muted { color: var(--dim); }
  /* The "/ assumed" half of a measured-vs-assumed card: same size and weight,
     a step down in color only. */
  .assumed { color: var(--dim); }
  .hidden { display: none; }
  code { background: #100d0b; padding: 1px 5px; border-radius: 4px; font-size: 13px; }
  .modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,.6);
              display: flex; align-items: center; justify-content: center; padding: 20px; }
  .modal { background: var(--panel); border: 1px solid var(--line);
           border-radius: var(--radius); padding: 20px; max-width: 560px; width: 100%;
           max-height: 80vh; overflow: auto; }
  @media (max-width: 720px) {
    body { padding: 14px; }
    .card { padding: 13px 14px; }
    /* Two stat cells per row on a phone: narrower minimum + smaller numbers. */
    .grid { grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }
    .stat { padding: 9px 10px; }
    .stat .k { font-size: 13px; }
    .stat .v { font-size: 17px; }
    th, td { padding: 7px 8px; }
    .modal-bg { padding: 10px; }
    .modal { padding: 16px; max-height: 90vh; }
  }
  .modal h3 { margin: 0 0 2px; font-size: 16px; }
  .x { float: right; background: none; border: none; color: var(--dim);
       font-size: 22px; cursor: pointer; padding: 0; line-height: 1; }
`;
