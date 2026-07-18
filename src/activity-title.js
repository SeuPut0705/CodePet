"use strict";

const STATUS_ICON_RULES = [
  [/실패$/, "error"],
  [/완료$/, "success"],
  [/(?:승인|입력) 대기$/, "waiting"],
  [/응답 작성 중$/, "writing"],
  [/파일 수정 중$/, "edit"],
  [/(?:자료|파일) 확인 중$/, "inspect"],
  [/요청 확인 중$/, "review"],
  [/이미지 생성 중$/, "image"],
  [/테스트 중$/, "test"],
  [/빌드 중$/, "build"],
  [/명령 실행 중$/, "terminal"],
  [/작업 중$/, "working"],
];

function activityStatusIcon(title) {
  const source = String(title || "");
  return STATUS_ICON_RULES.find(([pattern]) => pattern.test(source))?.[1] || null;
}

function externalProviderLabel(title) {
  const match = String(title || "").match(/^(AGY|Claude)\s/);
  return match?.[1] || null;
}

function formatActivityTitleLabel(title, context = {}) {
  const parts = [title];
  if (context.workerLabel) parts.push(context.workerLabel);
  if (context.reasoningLabel) parts.push(context.reasoningLabel);
  return parts.join(" · ");
}

// 아이콘은 renderer가 전용 글꼴로 그릴 수 있도록 제목 문자열과 분리합니다.
// rollout의 원본 모델·추론 값은 이 경로로 전달되지 않습니다.
function createActivityHeading(title, context = {}) {
  const icon = activityStatusIcon(title);
  const parts = icon ? [] : [title];
  const providerLabel = icon ? externalProviderLabel(title) : null;
  if (providerLabel) parts.push(providerLabel);
  if (context.workerLabel) parts.push(context.workerLabel);
  if (context.reasoningLabel) parts.push(context.reasoningLabel);
  return {
    statusIcon: icon,
    title: parts.join(" · "),
    titleLabel: formatActivityTitleLabel(title, context),
  };
}

module.exports = { createActivityHeading, formatActivityTitleLabel };
