"use strict";

const { parentPort } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");

let database = null;
let currentFile = null;

function open(file) {
  if (database && currentFile === file) return database;
  database?.close();
  database = new DatabaseSync(file, { readOnly: true });
  currentFile = file;
  return database;
}

parentPort.on("message", ({ id, file, sql }) => {
  try {
    const rows = open(file).prepare(sql).all();
    parentPort.postMessage({ id, rows });
  } catch (error) {
    try {
      database?.close();
    } catch {
      // 다음 조회에서 새 연결을 엽니다.
    }
    database = null;
    currentFile = null;
    parentPort.postMessage({ id, error: error?.message || String(error) });
  }
});

process.on("exit", () => {
  try {
    database?.close();
  } catch {
    // 프로세스 종료를 막지 않습니다.
  }
});
