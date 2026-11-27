/**
 * pageReady.js — 路由切换时等新页面真正就绪再揭幕
 *
 * 各 view 在首帧/资源加载完成后调用 markPageReady()；
 * loader 侧用 waitPageReady(timeout) 等它，超时兜底避免卡死。
 *
 * 这里的 ready / waiters 是模块级单例状态，整个应用共享同一份。
 */

// ready：当前页面是否已就绪；waiters：就绪前注册的等待回调队列
let ready = false;
let waiters = [];

/**
 * 标记当前页面已就绪
 *
 * 幂等：重复调用直接返回。首次调用时把队列里的等待者全部唤醒并清空。
 */
export function markPageReady() {
  if (ready) return;
  ready = true;
  // 先把队列换出再遍历：回调内部若再次注册等待者，不会影响本次的列表
  const list = waiters;
  waiters = [];
  for (const fn of list) fn();
}

/**
 * 重置就绪状态 — 每次进入新页面前调用，让 waitPageReady 重新开始等待
 * 同时清空旧页面的等待者，避免跨页面误触发
 */
export function resetPageReady() {
  ready = false;
  waiters = [];
}

/**
 * 等待当前页面就绪
 *
 * @param {number} [timeout=4000] — 超时毫秒数，超时后 resolve(false) 而不是 reject
 * @returns {Promise<boolean>} — true=页面确实就绪；false=超时兜底
 *
 * 超时存在的原因：某个 view 可能因为资源 404 / shader 编译失败而永远不会调用
 * markPageReady，没有兜底的话 loading 遮罩会一直盖住页面。
 */
export function waitPageReady(timeout = 4000) {
  // 已经就绪 → 直接同步返回一个已 resolve 的 Promise，避免多一次事件循环
  if (ready) return Promise.resolve(true);
  return new Promise((resolve) => {
    // 超时兜底：到点后返回 false，调用方仍会继续揭幕
    const timer = setTimeout(() => resolve(false), timeout);
    // 正常路径：就绪时清掉定时器并返回 true
    waiters.push(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
