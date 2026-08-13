(function registerActivityIcons(root) {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";

  const ICON_SHAPES = Object.freeze({
    working: [
      ["path", { d: "M8 1.5a6.5 6.5 0 1 1-5.15 2.53" }],
      ["path", { d: "M2.6 1.9v2.55h2.55" }],
    ],
    review: [
      ["path", { d: "M1.4 8s2.35-4 6.6-4 6.6 4 6.6 4-2.35 4-6.6 4-6.6-4-6.6-4Z" }],
      ["circle", { cx: "8", cy: "8", r: "1.75" }],
    ],
    writing: [
      ["path", { d: "M5.1 2.2h5.8l1.55 3.1L8 13.8 3.55 5.3 5.1 2.2Z" }],
      ["path", { d: "M8 13.8V7.2M6.6 6.55h2.8" }],
      ["path", { d: "M12.4 1.1v2M11.4 2.1h2" }],
    ],
    edit: [
      ["path", { d: "m3 10.75-.75 3 3-.75 7.7-7.7-2.25-2.25L3 10.75Z" }],
      ["path", { d: "m9.6 4.15 2.25 2.25M2.25 13.75h4" }],
    ],
    inspect: [
      ["path", { d: "M3 1.75h6l2.5 2.5v3.2M9 1.75v2.5h2.5M3 1.75v12.5h5" }],
      ["circle", { cx: "10.5", cy: "10.5", r: "2.45" }],
      ["path", { d: "m12.25 12.25 2 2M5 6h3M5 8.5h2" }],
    ],
    image: [
      ["rect", { x: "1.5", y: "3", width: "11.5", height: "10", rx: "1.5" }],
      ["circle", { cx: "5", cy: "6.25", r: "1" }],
      ["path", { d: "m2.2 11 3.1-3 2.2 2 2-1.8 2.8 2.8M13.2 1v2.4M12 2.2h2.4" }],
    ],
    test: [
      ["path", { d: "M5.25 1.5h5.5M6.5 1.5v4.2l-3.25 5.7a2 2 0 0 0 1.75 3h6a2 2 0 0 0 1.75-3L9.5 5.7V1.5" }],
      ["path", { d: "M4.7 9h6.6M6.2 11.2l1.15 1.15 2.45-2.45" }],
    ],
    build: [
      ["rect", { x: "5.25", y: "1.5", width: "5.5", height: "4.25", rx: "1" }],
      ["rect", { x: "1.5", y: "9.25", width: "5.5", height: "4.25", rx: "1" }],
      ["rect", { x: "9", y: "9.25", width: "5.5", height: "4.25", rx: "1" }],
      ["path", { d: "M8 5.75v1.5M4.25 9.25v-2h7.5v2" }],
    ],
    agents: [
      ["circle", { cx: "5", cy: "5", r: "2" }],
      ["circle", { cx: "11", cy: "5", r: "2" }],
      ["path", { d: "M1.5 13.5c.25-2.8 1.45-4.25 3.5-4.25s3.25 1.45 3.5 4.25" }],
      ["path", { d: "M7.5 13.5c.25-2.8 1.45-4.25 3.5-4.25s3.25 1.45 3.5 4.25" }],
    ],
    terminal: [
      ["rect", { x: "1.5", y: "2.25", width: "13", height: "11.5", rx: "2" }],
      ["path", { d: "m4.25 6 2 2-2 2M8.5 10h3" }],
    ],
    waiting: [
      ["circle", { cx: "8", cy: "8", r: "6.25" }],
      ["path", { d: "M6.2 5.25v5.5M9.8 5.25v5.5" }],
    ],
    success: [
      ["circle", { cx: "8", cy: "8", r: "6.25" }],
      ["path", { d: "m4.65 8.15 2.2 2.2 4.65-4.7" }],
    ],
    error: [
      ["circle", { cx: "8", cy: "8", r: "6.25" }],
      ["path", { d: "M8 4.5v4.25" }],
      ["circle", { cx: "8", cy: "11.25", r: ".45", fill: "currentColor", stroke: "none" }],
    ],
  });

  function createActivityIcon(documentRef, iconId) {
    if (!Object.hasOwn(ICON_SHAPES, iconId)) return null;
    const shapes = ICON_SHAPES[iconId];

    const svg = documentRef.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "status-icon");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.75");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.dataset.status = iconId;

    for (const [tagName, attributes] of shapes) {
      const shape = documentRef.createElementNS(SVG_NS, tagName);
      for (const [name, value] of Object.entries(attributes)) {
        shape.setAttribute(name, value);
      }
      svg.appendChild(shape);
    }

    return svg;
  }

  const activityIcons = Object.freeze({ createActivityIcon });
  if (root) root.activityIcons = activityIcons;
  if (typeof module !== "undefined" && module.exports) module.exports = activityIcons;
})(typeof window !== "undefined" ? window : globalThis);
