"use strict";

// 활동 말풍선에는 명령의 목적만 필요합니다. 인증 헤더·환경변수·CLI 옵션·URL에
// 실린 비밀값은 공급자와 관계없이 이 경계에서 한 번 더 마스킹합니다.
function redactActivityDetail(value) {
  let source = String(value ?? "");
  if (!source) return "";

  source = source
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(
      /(\b(?:authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie)\s*:\s*)(?:"[^"]*"|'[^']*'|[^\r\n]+)/gi,
      "$1[redacted]"
    )
    .replace(
      /(^|\s)(-u|--user)(?:\s+|=)(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
      "$1$2 [redacted]"
    )
    .replace(
      /(^|\s)((?:--?)(?:api[-_]?key|token|secret|password|passwd|access[-_]?token|refresh[-_]?token))(?:\s+|=)(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
      "$1$2 [redacted]"
    )
    .replace(
      /\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s]+)/g,
      (match, key) => /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|PRIVATE|CERT)/i.test(key)
        ? `${key}=[redacted]`
        : match
    )
    .replace(
      /([?&](?:api[-_]?key|token|secret|password|access[-_]?token|refresh[-_]?token)=)[^&\s]+/gi,
      "$1[redacted]"
    )
    .replace(
      /("(?:apiKey|api_key|token|secret|password|accessToken|access_token|refreshToken|refresh_token)"\s*:\s*)"[^"]*"/gi,
      '$1"[redacted]"'
    );

  return source;
}

module.exports = { redactActivityDetail };
