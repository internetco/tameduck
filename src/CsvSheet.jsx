import React, {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CSV_PREVIEW_BYTES,
  columnLabel,
  decodeCsvBytes,
  parseCsv,
} from "./csv.mjs";
import {
  cellHeading,
  fitToRoom,
  fitWidths,
  headedSheet,
  numberColumns,
  pickHint,
  sheetStrip,
  sheetWidth,
} from "./file-viewer.mjs";
import "./csv-sheet.css";

export function CsvSheet({
  source,
  delimiter = ",",
  label = "CSV spreadsheet",
  // The look of a file opened for a look in its own window. A sheet inside a
  // chat answer, and the ticket page's own file dialog, keep the one below.
  fill = false,
}) {
  const result = useMemo(
    () => parseCsv(source, { delimiter }),
    [source, delimiter],
  );
  const width = Math.max(0, ...result.rows.map((row) => row.length));
  const widths = Array.from({ length: width }, (_, column) =>
    Math.max(
      120,
      Math.min(
        320,
        24 +
          Math.max(
            ...result.rows.map((row) =>
              Math.max(
                ...String(row[column] || "")
                  .split(/\r?\n/)
                  .map((line) => line.length),
              ),
            ),
          ) *
            7,
      ),
    ),
  );
  if (result.error)
    return (
      <div className="csv-fallback">
        <p role="status">{result.error}</p>
        <pre>{source}</pre>
      </div>
    );
  if (!result.rows.length)
    return <p className="muted">This spreadsheet is empty.</p>;
  if (fill)
    return (
      <FilledSheet
        rows={result.rows}
        truncated={result.truncated}
        label={label}
      />
    );
  return (
    <div className="csv-sheet">
      <div className="csv-sheet-info">
        {result.rows.length} rows · {width} columns
        {result.truncated ? " · Limited preview" : ""}
      </div>
      <div
        className="csv-sheet-scroll"
        tabIndex={0}
        role="region"
        aria-label={label + " — scroll to view more cells"}
      >
        <table
          aria-label={label}
          style={{
            width: 42 + widths.reduce((sum, value) => sum + value, 0),
            tableLayout: "fixed",
          }}
        >
          <colgroup>
            <col style={{ width: 42 }} />
            {widths.map((width, i) => (
              <col key={i} style={{ width }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="csv-corner" aria-label="Row number" />
              {Array.from({ length: width }, (_, i) => (
                <th scope="col" key={i}>
                  {columnLabel(i)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, r) => (
              <tr key={r}>
                <th scope="row">{r + 1}</th>
                {Array.from({ length: width }, (_, c) => (
                  <td key={c} className={r === 0 ? "csv-first-row" : undefined}>
                    {row[c] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {result.truncated && (
        <p className="csv-sheet-note">
          Showing up to 501 rows and 100 columns. Export or download to view the
          complete content.
        </p>
      )}
    </div>
  );
}
export function CsvFilePreview({ item, url, fill = false }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true });
    (async () => {
      try {
        if (item.size > CSV_PREVIEW_BYTES)
          throw new Error(
            "This file is too big to show here. Download it to see all of it.",
          );
        // Offline, this said the browser's own "Failed to fetch".
        const unreached = () => {
          throw new Error(
            "The spreadsheet could not be loaded. Check your connection and try again.",
          );
        };
        const response = await fetch(url, { signal: controller.signal }).catch(
          unreached,
        );
        if (!response.ok)
          throw new Error(
            "The spreadsheet could not be loaded. Close it and try again.",
          );
        const bytes = new Uint8Array(
          await response.arrayBuffer().catch(unreached),
        );
        if (bytes.length > CSV_PREVIEW_BYTES)
          throw new Error(
            "This file is too big to show here. Download it to see all of it.",
          );
        if (!controller.signal.aborted)
          setState({ source: decodeCsvBytes(bytes) });
      } catch (error) {
        if (!controller.signal.aborted) setState({ error: error.message });
      }
    })();
    return () => controller.abort();
  }, [item.id, item.size, url]);
  if (state.loading) return <p role="status">Loading spreadsheet…</p>;
  if (state.error) return <p role="status">{state.error}</p>;
  return (
    <CsvSheet
      source={state.source}
      delimiter={
        /\.tsv$/i.test(item.name) || item.mime === "text/tab-separated-values"
          ? "\t"
          : ","
      }
      label={item.name}
      fill={fill}
    />
  );
}

export function SpreadsheetRowsPreview({
  rows,
  truncated,
  label = "Spreadsheet",
}) {
  if (!rows?.length) return <p className="muted">This spreadsheet is empty.</p>;
  return (
    <FilledSheet
      rows={rows}
      truncated={truncated}
      label={label}
      truncationNote="Only part of this worksheet is shown. Download the file to see all of it."
    />
  );
}

// A sheet in a window of its own. Row 1 is the names and stays on top, the
// first column stays at the left, and every row is one line: a long note
// wrapping in a column nobody could see made rows jump between 37px and 56px.
// A cell's whole text shows under the grid when it is clicked, or reached with
// the arrow keys.
const PHONE = "(max-width: 640px)";
// A screen you touch: a sheet is swiped and a cell is tapped.
const TOUCH = "(pointer: coarse)";
// How wide words really are in the app's font, so a column fits what is in it.
function textWidth() {
  const pen = document.createElement("canvas").getContext?.("2d");
  if (!pen) return (text) => text.length * 7;
  const family = getComputedStyle(document.body).fontFamily;
  const known = new Map();
  return (text, weight = 400, size = 13) => {
    const key = weight + " " + size + " " + text;
    if (!known.has(key)) {
      pen.font = weight + " " + size + "px " + family;
      known.set(key, pen.measureText(text).width);
    }
    return known.get(key);
  };
}
const onPhone = () => !!window.matchMedia?.(PHONE).matches;
const byTouch = () => !!window.matchMedia?.(TOUCH).matches;
function FilledSheet({
  rows,
  truncated,
  label,
  truncationNote = "Only the first 500 rows and 100 columns are shown here. Download the file to see all of it.",
}) {
  const sheet = useMemo(() => headedSheet(rows), [rows]);
  const measure = useMemo(textWidth, []);
  const [narrow, setNarrow] = useState(onPhone);
  const [touch, setTouch] = useState(byTouch);
  // On a phone any one column fits beside the pinned first one.
  const most = narrow
    ? Math.max(160, Math.min(320, Math.round(window.innerWidth * 0.6)))
    : 320;
  const widths = useMemo(
    () => fitWidths(sheet, measure, most),
    [sheet, measure, most],
  );
  const numbers = useMemo(() => numberColumns(sheet), [sheet]);
  const { names, body, width } = sheet;
  const [picked, setPicked] = useState(null);
  const [wider, setWider] = useState(false);
  const [atEnd, setAtEnd] = useState(false);
  const [room, setRoom] = useState(0);
  const box = useRef(null);
  useEffect(() => {
    const media = window.matchMedia?.(PHONE);
    if (!media) return;
    const change = () => setNarrow(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    const media = window.matchMedia?.(TOUCH);
    if (!media) return;
    const change = () => setTouch(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  const track = () => {
    const el = box.current;
    if (!el) return;
    setRoom(el.clientWidth);
    setWider(el.scrollWidth > el.clientWidth + 1);
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 2);
  };
  useEffect(() => {
    track();
    if (!box.current || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(track);
    watch.observe(box.current);
    return () => watch.disconnect();
  }, [narrow, sheet]);
  // Row numbers are for a laptop; on a phone the first column is the name.
  const numberWidth = narrow
    ? 0
    : Math.ceil(18 + measure("8".repeat(String(body.length).length)));
  const fitted = useMemo(
    () => fitToRoom(widths, numberWidth, room, numbers[width - 1]),
    [widths, numberWidth, room, numbers, width],
  );
  const total = sheetWidth(fitted, numberWidth, room);
  useEffect(track, [total]);
  const active = picked || { r: 0, c: 0 };
  const cellAt = (event) => {
    const cell = event.target.closest?.("[data-c]");
    const r = cell?.parentElement?.dataset.r;
    return cell && r !== undefined
      ? { cell, r: Number(r), c: Number(cell.dataset.c) }
      : null;
  };
  const pick = (event) => {
    const at = cellAt(event);
    if (at)
      setPicked((was) =>
        was && was.r === at.r && was.c === at.c ? was : { r: at.r, c: at.c },
      );
  };
  // The pinned heading and first column would cover a cell the browser only
  // scrolls to the edge of, so the grid scrolls it clear of them itself.
  const reveal = (cell, c) => {
    const view = box.current;
    const frame = view.getBoundingClientRect(),
      at = cell.getBoundingClientRect();
    const top = frame.top + (view.querySelector("thead")?.offsetHeight || 0);
    const bottom = frame.top + view.clientHeight;
    if (at.top < top) view.scrollTop -= top - at.top;
    else if (at.bottom > bottom) view.scrollTop += at.bottom - bottom;
    if (c === 0) return;
    const pinned = view.querySelector("thead .csv-fill-name");
    const left = pinned ? pinned.getBoundingClientRect().right : frame.left;
    const right = frame.left + view.clientWidth;
    if (at.left < left) view.scrollLeft -= left - at.left;
    else if (at.right > right) view.scrollLeft += at.right - right;
  };
  const move = (event) => {
    const at = cellAt(event);
    if (!at) return;
    const ends = event.ctrlKey || event.metaKey;
    const to = {
      ArrowUp: [at.r - 1, at.c],
      ArrowDown: [at.r + 1, at.c],
      ArrowLeft: [at.r, at.c - 1],
      ArrowRight: [at.r, at.c + 1],
      Home: ends ? [0, 0] : [at.r, 0],
      End: ends ? [body.length - 1, width - 1] : [at.r, width - 1],
      PageUp: [at.r - 10, at.c],
      PageDown: [at.r + 10, at.c],
    }[event.key];
    if (!to) return;
    event.preventDefault();
    const r = Math.max(0, Math.min(body.length - 1, to[0])),
      c = Math.max(0, Math.min(width - 1, to[1]));
    const next = box.current.querySelector(
      'tr[data-r="' + r + '"] > [data-c="' + c + '"]',
    );
    if (!next) return;
    next.focus({ preventScroll: true });
    reveal(next, c);
  };
  // Again once the panel under the grid has its height: it opens or grows
  // after the click, and took the picked cell out of sight beneath it.
  useLayoutEffect(() => {
    if (!picked || !box.current) return;
    const cell = box.current.querySelector(
      'tr[data-r="' + picked.r + '"] > [data-c="' + picked.c + '"]',
    );
    if (cell) reveal(cell, picked.c);
  }, [picked]);
  const text = picked ? String(body[picked.r]?.[picked.c] ?? "") : "";
  const empty = body.length === 0;
  return (
    <div className="csv-fill" style={{ "--csv-numbers": numberWidth + "px" }}>
      <div className="csv-fill-strip">
        <span>
          {sheetStrip({
            rows: body.length,
            columns: width,
            narrow,
            touch,
            wider,
            atEnd,
          })}
        </span>
        {!narrow && !empty && <span>{pickHint(touch)}</span>}
      </div>
      <div
        className="csv-fill-scroll"
        ref={box}
        // The table carries the file's name; the region only when there are
        // no cells to reach, so the keyboard can still scroll a wide heading.
        {...(empty ? { role: "region", "aria-label": label, tabIndex: 0 } : {})}
        onScroll={track}
        onKeyDown={move}
        onFocus={pick}
        onClick={(event) => {
          pick(event);
          const at = cellAt(event);
          if (at) reveal(at.cell, at.c);
        }}
      >
        <table
          aria-label={label}
          // A last column of words takes whatever room is left over. One of
          // numbers keeps its own width: stretched to the edge, "20" stood a
          // whole window away from the "Rye" it belongs to.
          style={{
            width: numbers[width - 1] ? total : `max(100%, ${total}px)`,
          }}
        >
          <colgroup>
            {!narrow && <col style={{ width: numberWidth }} />}
            {fitted.map((w, c) => (
              <col key={c} style={c < width - 1 ? { width: w } : undefined} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {!narrow && (
                <th
                  className="csv-fill-number"
                  scope="col"
                  aria-label="Row number"
                />
              )}
              {names.map((name, c) => (
                <th
                  key={c}
                  scope="col"
                  className={
                    [
                      c === 0 && "csv-fill-name",
                      numbers[c] && "csv-fill-amount",
                    ]
                      .filter(Boolean)
                      .join(" ") || undefined
                  }
                >
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, r) => (
              <SheetRow
                key={r}
                row={row}
                r={r}
                width={width}
                numbers={numbers}
                narrow={narrow}
                picked={picked?.r === r ? picked.c : -1}
                active={active.r === r ? active.c : -1}
              />
            ))}
          </tbody>
        </table>
        {empty && (
          <p className="csv-fill-none">
            This sheet has column names but no rows.
          </p>
        )}
      </div>
      {picked && (
        <div className="csv-fill-cell">
          <b>{cellHeading(sheet, picked.r, picked.c)}</b>
          {text.trim() ? (
            <p>{text}</p>
          ) : (
            <p className="csv-fill-empty">Nothing in this cell.</p>
          )}
        </div>
      )}
      {truncated && <p className="csv-fill-note">{truncationNote}</p>}
    </div>
  );
}
// Rows only draw again when their own cell is picked or let go, so moving
// through a sheet of 500 rows does not redraw the other 498.
const SheetRow = memo(function SheetRow({
  row,
  r,
  width,
  numbers,
  narrow,
  picked,
  active,
}) {
  return (
    <tr data-r={r}>
      {!narrow && <td className="csv-fill-number">{r + 1}</td>}
      {Array.from({ length: width }, (_, c) => {
        const Cell = c === 0 ? "th" : "td";
        return (
          <Cell
            key={c}
            data-c={c}
            scope={c === 0 ? "row" : undefined}
            tabIndex={active === c ? 0 : -1}
            className={
              [
                c === 0 && "csv-fill-name",
                numbers[c] && "csv-fill-amount",
                picked === c && "picked",
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
          >
            {row[c] ?? ""}
          </Cell>
        );
      })}
    </tr>
  );
});
