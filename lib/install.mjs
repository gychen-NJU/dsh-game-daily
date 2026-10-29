// 通过 Host 的 sessionController 在 DSH 里开一个会话，把 prompt 投进去（依赖安装 / 结果汇报共用）。
import crypto from 'node:crypto';

function getService(ctx, key) {
  try {
    if (ctx && typeof ctx.get === 'function') {
      const value = ctx.get(key);
      if (value) return value;
    }
  } catch {
    /* ignore */
  }
  return ctx ? ctx[key] : undefined;
}

function textPart(text) {
  return { type: 'text', text };
}

/**
 * 打开一个普通 DSH 会话并投递 prompt。
 * @returns {Promise<{ok:true, sessionId:string}|{ok:false,error:string}>}
 */
export async function openSession(ctx, { prompt, title, cwd }) {
  const controller = getService(ctx, 'sessionController');
  if (!controller || typeof controller.create !== 'function') {
    return { ok: false, error: 'Host 没有 sessionController（无法新建会话）' };
  }
  const WORKSPACE_TITLE = '游戏日常';
  let workspaceId;
  const registry = getService(ctx, 'workspaceRegistry');
  if (registry && cwd && typeof registry.resolveByPath === 'function') {
    try {
      let workspace = await registry.resolveByPath(cwd);
      if (!workspace && typeof registry.create === 'function') {
        // 会话挂在未注册的 cwd 上会在侧边栏里“隐身”，用户点完按钮找不到新会话。
        workspace = await registry.create(cwd, WORKSPACE_TITLE);
      } else if (workspace && workspace.title !== WORKSPACE_TITLE && typeof workspace.setTitle === 'function') {
        // 早先版本用会话标题当了工作区名，这里纠正回来（用户改过名也只会被纠成固定名）。
        await workspace.setTitle(WORKSPACE_TITLE);
      }
      if (workspace && workspace.id) workspaceId = workspace.id;
    } catch {
      /* 工作区注册失败不阻塞会话创建 */
    }
  }

  let created;
  try {
    created = await controller.create(workspaceId ? { workspaceId } : cwd ? { cwd } : {});
  } catch (error) {
    return { ok: false, error: `创建会话失败：${String((error && error.message) || error)}` };
  }
  const sessionId = created && (created.sessionId || created.id);
  if (!sessionId) return { ok: false, error: '创建会话没有返回 sessionId' };

  if (title && typeof controller.rename === 'function') {
    try {
      await controller.rename({ sessionId, title });
    } catch {
      /* 改不了标题不影响投递 */
    }
  }
  try {
    // Host 的 prompt 签名是 (request, signal)，signal 缺省会在 throwIfAborted 处炸掉。
    const controllerSignal = new AbortController();
    await controller.prompt(
      {
        requestId: crypto.randomUUID(),
        sessionId,
        mode: 'queue',
        content: [textPart(prompt)],
      },
      controllerSignal.signal,
    );
  } catch (error) {
    return { ok: false, error: `投递 prompt 失败：${String((error && error.message) || error)}`, sessionId };
  }
  return { ok: true, sessionId };
}

/**
 * 会话是否还真实存在（用户可能已经把旧汇报会话删了；prompt 对已删除的会话不一定报错，得先 inspect）。
 * @returns {Promise<boolean>}
 */
export async function sessionExists(ctx, sessionId) {
  const controller = getService(ctx, 'sessionController');
  if (!controller || typeof controller.inspect !== 'function' || !sessionId) return false;
  try {
    const info = await controller.inspect(sessionId);
    return Boolean(info && (info.meta || info.events));
  } catch {
    return false;
  }
}

/**
 * 把 prompt 追加到一个**已经存在**的会话里（汇报会话按游戏复用，避免每轮新建一堆会话）。
 * 会话被用户删掉或不可用时返回 ok:false，由调用方决定是否新建。
 * @returns {Promise<{ok:true, sessionId:string}|{ok:false, error:string, sessionId:string}>}
 */
export async function appendSession(ctx, { sessionId, prompt }) {
  const controller = getService(ctx, 'sessionController');
  if (!controller || typeof controller.prompt !== 'function') {
    return { ok: false, error: 'Host 没有 sessionController（无法投递）', sessionId };
  }
  if (!sessionId) return { ok: false, error: '没有可复用的 sessionId', sessionId };
  try {
    const controllerSignal = new AbortController();
    await controller.prompt(
      {
        requestId: crypto.randomUUID(),
        sessionId,
        mode: 'queue',
        content: [textPart(prompt)],
      },
      controllerSignal.signal,
    );
  } catch (error) {
    return { ok: false, error: `追加到旧会话失败：${String((error && error.message) || error)}`, sessionId };
  }
  return { ok: true, sessionId };
}
