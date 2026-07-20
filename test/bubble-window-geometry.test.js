const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizePreferredBubbleSize,
  normalizeBubbleSize,
  positionBubbleBounds,
} = require("../src/bubble-window-geometry");

const limits = {
  currentWidth: 300,
  currentHeight: 80,
  minWidth: 300,
  maxWidth: 520,
  minHeight: 48,
  maxHeight: 420,
  marginPx: 12,
};

test("말풍선 크기는 300..520 범위에서 콘텐츠 보고값을 사용한다", () => {
  assert.deepEqual(
    normalizeBubbleSize({ width: 410, height: 120 }, {
      ...limits,
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
    }),
    { width: 410, height: 120 }
  );
  assert.deepEqual(
    normalizeBubbleSize({ width: 900, height: 900 }, {
      ...limits,
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
    }),
    { width: 520, height: 420 }
  );
});

test("작은 work area에서는 좌우 12px 여백 상한을 우선한다", () => {
  assert.deepEqual(
    normalizeBubbleSize({ width: 520, height: 100 }, {
      ...limits,
      workArea: { x: 40, y: 20, width: 320, height: 600 },
    }),
    { width: 296, height: 100 }
  );
});

test("wide→narrow→wide 전환은 renderer 선호 폭을 새 보고 없이 복원한다", () => {
  const preferred = normalizePreferredBubbleSize(
    { width: 500, height: 120 },
    limits
  );
  const wide = normalizeBubbleSize(preferred, {
    ...limits,
    workArea: { x: 0, y: 0, width: 1440, height: 900 },
  });
  const narrow = normalizeBubbleSize(preferred, {
    ...limits,
    currentWidth: wide.width,
    currentHeight: wide.height,
    workArea: { x: 0, y: 0, width: 320, height: 900 },
  });
  const restored = normalizeBubbleSize(preferred, {
    ...limits,
    currentWidth: narrow.width,
    currentHeight: narrow.height,
    workArea: { x: 0, y: 0, width: 1440, height: 900 },
  });

  assert.deepEqual(preferred, { width: 500, height: 120 });
  assert.deepEqual([wide.width, narrow.width, restored.width], [500, 296, 500]);
});

test("tall→short→tall 전환은 renderer 선호 높이를 새 보고 없이 복원한다", () => {
  const preferred = normalizePreferredBubbleSize(
    { width: 360, height: 380 },
    limits
  );
  const tall = normalizeBubbleSize(preferred, {
    ...limits,
    workArea: { x: 0, y: 0, width: 1000, height: 900 },
  });
  const short = normalizeBubbleSize(preferred, {
    ...limits,
    currentWidth: tall.width,
    currentHeight: tall.height,
    workArea: { x: 0, y: 0, width: 1000, height: 180 },
  });
  const restored = normalizeBubbleSize(preferred, {
    ...limits,
    currentWidth: short.width,
    currentHeight: short.height,
    workArea: { x: 0, y: 0, width: 1000, height: 900 },
  });

  assert.deepEqual(preferred, { width: 360, height: 380 });
  assert.deepEqual([tall.height, short.height, restored.height], [380, 180, 380]);
});

test("legacy height 보고는 선호 높이만 갱신하고 선호 폭을 보존한다", () => {
  assert.deepEqual(
    normalizePreferredBubbleSize(190, {
      ...limits,
      currentWidth: 470,
      currentHeight: 120,
    }),
    { width: 470, height: 190 }
  );
});

test("이전 큰 크기는 현재 작은 work area의 폭과 높이에 다시 맞춘다", () => {
  assert.deepEqual(
    normalizeBubbleSize(null, {
      ...limits,
      currentWidth: 520,
      currentHeight: 420,
      workArea: { x: 40, y: 20, width: 320, height: 200 },
    }),
    { width: 296, height: 200 }
  );
});

test("일반 화면은 48px 최소 높이를 지키고 더 작은 화면은 실제 높이에 맞춘다", () => {
  assert.deepEqual(
    normalizeBubbleSize({ width: 300, height: 20 }, {
      ...limits,
      workArea: { x: 0, y: 0, width: 800, height: 600 },
    }),
    { width: 300, height: 48 }
  );
  assert.deepEqual(
    normalizeBubbleSize({ width: 300, height: 100 }, {
      ...limits,
      workArea: { x: 0, y: 0, width: 800, height: 32 },
    }),
    { width: 300, height: 32 }
  );
});

test("legacy 숫자 height와 잘못된 width는 현재 폭을 보존한다", () => {
  assert.deepEqual(
    normalizeBubbleSize(160, {
      ...limits,
      currentWidth: 380,
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
    }),
    { width: 380, height: 160 }
  );
  assert.deepEqual(
    normalizeBubbleSize({ width: "bad", height: 90 }, {
      ...limits,
      currentWidth: 360,
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
    }),
    { width: 360, height: 90 }
  );
});

test("배열 payload는 합성 크기 속성이 있어도 현재 크기를 보존한다", () => {
  const arrayWithSizeProperties = Object.assign([1], {
    width: 500,
    height: 200,
  });

  for (const payload of [[], [1], arrayWithSizeProperties]) {
    assert.deepEqual(
      normalizeBubbleSize(payload, {
        ...limits,
        currentWidth: 380,
        currentHeight: 90,
        workArea: { x: 0, y: 0, width: 1440, height: 900 },
      }),
      { width: 380, height: 90 }
    );
  }
});

test("0px work area 폭은 유효한 초소형 폭으로 처리한다", () => {
  assert.deepEqual(
    normalizeBubbleSize({ width: 520, height: 100 }, {
      ...limits,
      workArea: { x: 40, y: 20, width: 0, height: 600 },
    }),
    { width: 1, height: 100 }
  );
});

test("실제 반응형 폭으로 pet 중심과 화면 좌우 경계를 보정한다", () => {
  assert.deepEqual(
    positionBubbleBounds({
      petBounds: { x: 760, y: 500, width: 120, height: 120 },
      workArea: { x: 0, y: 0, width: 800, height: 700 },
      bubbleSize: { width: 500, height: 100 },
      gapPx: 2,
      marginPx: 12,
    }),
    { x: 288, y: 398, width: 500, height: 100 }
  );
});

test("일반 화면 왼쪽과 오른쪽 가장자리에서 각각 12px inset을 지킨다", () => {
  const workArea = { x: 40, y: 20, width: 800, height: 700 };
  const common = {
    workArea,
    bubbleSize: { width: 300, height: 100 },
    gapPx: 2,
    marginPx: 12,
  };

  assert.equal(positionBubbleBounds({
    ...common,
    petBounds: { x: 0, y: 500, width: 120, height: 120 },
  }).x, 52);
  assert.equal(positionBubbleBounds({
    ...common,
    petBounds: { x: 800, y: 500, width: 120, height: 120 },
  }).x, 528);
});

test("oversize 말풍선 입력도 작은 work area 안에 완전히 포함한다", () => {
  const workArea = { x: 40, y: 20, width: 320, height: 200 };
  const bounds = positionBubbleBounds({
    petBounds: { x: 280, y: 160, width: 120, height: 120 },
    workArea,
    bubbleSize: { width: 520, height: 420 },
    gapPx: 2,
    marginPx: 12,
  });

  assert.deepEqual(bounds, { x: 40, y: 20, width: 320, height: 200 });
  assert.deepEqual(
    {
      left: bounds.x >= workArea.x,
      top: bounds.y >= workArea.y,
      right: bounds.x + bounds.width <= workArea.x + workArea.width,
      bottom: bounds.y + bounds.height <= workArea.y + workArea.height,
    },
    { left: true, top: true, right: true, bottom: true }
  );
});
