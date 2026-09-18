// 引用影响分析：在「当前确认后的解析图」（analysis.edges，条级）上，
// 沿引用边反向遍历，计算所有直接 / 间接引用目标条的源条款，
// 按最短引用距离分层，并标注与目标处于同一循环（强连通分量）的源条。
// 纯计算模块：结果仅用于当前会话展示，不修改正文、不进入撤销历史。

import type { Analysis, ArticleEdge, ClauseNode } from '../../shared/model';
import { formatOrdinal } from './numeral';

/** 一条去重后的条级引用边（同一条对只保留一条，记录代表出现的 refKey） */
export interface ImpactEdge {
  from: string;
  to: string;
  /** 该条对任意一条引用出现的 refKey（点击结果行时跳回产生引用的正文） */
  refKey: string;
  /** 产生该引用的具体源节点（可能是款 / 项） */
  sourceNodeId: string;
}

/** 影响分析结果中的一个源条（直接或间接引用目标条的条） */
export interface ImpactSource {
  articleId: string;
  /** 最短引用距离：1 = 直接引用目标条，2 = 经一条中转，以此类推 */
  distance: number;
  /** 该源条上构成「最短路径第一步」的出边（点击跳回正文用） */
  viaEdge: ImpactEdge;
  /** 与目标条处于同一循环（强连通分量） */
  inCycle: boolean;
}

export interface ImpactLayer {
  distance: number;
  sources: ImpactSource[];
}

export interface ImpactResult {
  targetId: string;
  /** 反向 BFS 距离表（目标条自身距离为 0） */
  distances: Map<string, number>;
  /** 目标条所在循环的成员条 id（不在循环中时为空集合） */
  cycleArticleIds: Set<string>;
  /** 去重后的条级边（与关系视图口径一致：条内相对自指不计自环） */
  edges: ImpactEdge[];
  layers: ImpactLayer[];
  /** 引用目标条的源条总数（不含目标自身） */
  total: number;
}

/**
 * 从分析结果构造去重条级边集合：
 * 与关系视图一致，同一条对只保留一条；源、目标相同的绝对自引用（self 问题）
 * 才保留为自环，条内「本条 / 前款」等相对自指不作为边参与影响分析。
 */
export function impactEdges(analysis: Analysis): ImpactEdge[] {
  const selfProblemKeys = new Set(
    analysis.issues.filter((i) => i.type === 'self' && i.refKey).map((i) => i.refKey!),
  );
  const map = new Map<string, ImpactEdge>();
  for (const e of analysis.edges) {
    const k = `${e.sourceArticleId}>${e.targetArticleId}`;
    if (map.has(k)) continue;
    if (e.sourceArticleId === e.targetArticleId && !selfProblemKeys.has(e.refKey)) continue;
    map.set(k, edgeOf(e));
  }
  return [...map.values()];
}

function edgeOf(e: ArticleEdge): ImpactEdge {
  return {
    from: e.sourceArticleId,
    to: e.targetArticleId,
    refKey: e.refKey,
    sourceNodeId: e.sourceNodeId,
  };
}

/**
 * 计算引用某一条款的全部源条款。
 *
 * 反向 BFS：从目标条出发沿「to → from」遍历，第一次到达即为最短距离，
 * 天然完成「循环路径去重」——同一源条无论经多少条循环路径可达，只在其
 * 最短距离层出现一次；与目标条处于同一强连通分量（含绝对自指自环）的
 * 源条额外标注 inCycle。
 */
export function computeImpact(analysis: Analysis, targetArticleId: string): ImpactResult | null {
  if (!analysis.articles.some((a) => a.id === targetArticleId)) return null;

  const edges = impactEdges(analysis);

  // 反向邻接：to -> 指向 to 的边；正向邻接：from -> 从 from 出发的边（循环判定用）
  const reverse = new Map<string, ImpactEdge[]>();
  const forward = new Map<string, ImpactEdge[]>();
  for (const e of edges) {
    const r = reverse.get(e.to) ?? [];
    r.push(e);
    reverse.set(e.to, r);
    const f = forward.get(e.from) ?? [];
    f.push(e);
    forward.set(e.from, f);
  }

  // 反向 BFS 求最短距离
  const distances = new Map<string, number>([[targetArticleId, 0]]);
  // 记录每个源条最短路径上「指向更靠近目标一层」的第一条出边
  const via = new Map<string, ImpactEdge>();
  const queue: string[] = [targetArticleId];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const d = distances.get(cur)!;
    for (const e of reverse.get(cur) ?? []) {
      if (!distances.has(e.from)) {
        distances.set(e.from, d + 1);
        via.set(e.from, e);
        queue.push(e.from);
      }
    }
  }

  // 目标条所在强连通分量（成员 > 1，或存在绝对自指自环时视为循环）
  const cycleArticleIds = sccOf(targetArticleId, forward, reverse);

  const byDistance = new Map<number, ImpactSource[]>();
  for (const [id, distance] of distances) {
    if (id === targetArticleId) continue;
    const layer = byDistance.get(distance) ?? [];
    layer.push({
      articleId: id,
      distance,
      viaEdge: via.get(id)!,
      inCycle: cycleArticleIds.has(id),
    });
    byDistance.set(distance, layer);
  }

  const order = new Map(analysis.articles.map((a, i) => [a.id, i]));
  const layers: ImpactLayer[] = [...byDistance.keys()]
    .sort((a, b) => a - b)
    .map((distance) => ({
      distance,
      sources: byDistance
        .get(distance)!
        .sort(
          (x, y) =>
            (order.get(x.articleId) ?? Number.MAX_SAFE_INTEGER) -
            (order.get(y.articleId) ?? Number.MAX_SAFE_INTEGER),
        ),
    }));

  return {
    targetId: targetArticleId,
    distances,
    cycleArticleIds,
    edges,
    layers,
    total: layers.reduce((n, l) => n + l.sources.length, 0),
  };
}

/**
 * 求 start 所在的强连通分量（正反两次可达取交集）；
 * 仅当分量成员 > 1 或 start 存在自环时才视为循环，否则返回空集合。
 */
function sccOf(
  start: string,
  forward: Map<string, ImpactEdge[]>,
  reverse: Map<string, ImpactEdge[]>,
): Set<string> {
  const hasLoop = (forward.get(start) ?? []).some((e) => e.from === start && e.to === start);
  const reachableForward = collect(start, forward, (e) => e.to);
  if (reachableForward.size <= 1 && !hasLoop) return new Set();
  const reachableReverse = collect(start, reverse, (e) => e.from);
  const scc = new Set<string>();
  for (const id of reachableForward) {
    if (reachableReverse.has(id)) scc.add(id);
  }
  if (scc.size <= 1 && !hasLoop) return new Set();
  return scc;
}

function collect(
  start: string,
  adj: Map<string, ImpactEdge[]>,
  nextOf: (e: ImpactEdge) => string,
): Set<string> {
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of adj.get(cur) ?? []) {
      const next = nextOf(e);
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

/** 供界面展示的条标题：编号 + 条标题；无标题时附正文摘要 */
export function impactArticleLabel(analysis: Analysis, articleId: string): string {
  const article = analysis.nodes[articleId] as ClauseNode | undefined;
  if (!article) return '（已删除条款）';
  const ord = `第${formatOrdinal(article.ordinal)}条${article.suffix ? `之${article.suffix}` : ''}`;
  if (article.title) return `${ord} ${article.title}`;
  const summary = (article.text || '').replace(/\s+/g, ' ').slice(0, 18);
  return summary ? `${ord}｜${summary}…` : ord;
}
