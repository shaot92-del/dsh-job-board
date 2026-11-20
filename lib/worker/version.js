// worker 侧版本号的**唯一来源**（v2.6.13）。
//
// 以前 VERSION 字面量写在 lib/worker/index.js，HTTP 传输层的默认 UA 又各写一份
// 'dsh-job-board/2.6.12'，发版时漏改就会让远端看到的 UA 停在旧版本。
// 现在叶子模块只放这个常量，index.js 原样 re-export（对外 API 不变），
// transport/http.js 的默认 UA 也引用它，不再有第二处字面量。
//
// 三处版本号必须一致：package.json / 这里 / lib/client.js 的 CLIENT_VERSION。
// scripts/plugcheck.mjs 会断言，漏改会卡 gate。
export const VERSION = '2.6.28'

