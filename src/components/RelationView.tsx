import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../lib/context';
import { useHighlighter } from '../lib/highlighter';
import { shortArticleLabel } from '../lib/labels';
import { formatOrdinal } from '../lib/numeral';
import { locateSentence } from '../lib/analyzer';
import { computeImpact, impactArticleLabel, type ImpactResult } from '../lib/impact';

const W = 520;
const H = 560;

export function RelationView() {
  const { store, highlighter } = useApp();
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  const hl = useHighlighter(highlighter);
  const { analysis } = store.getSnapshot();

  // 引用影响分析的选中条款：仅当前会话 UI 状态，不持久化、不进入撤销历史
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);

  const positions = useMemo(() => {
    const n = analysis.articles.length;
    const map = new Map<string, { x: number; y: number }>();
    const cx = W / 2;
    const cy = H / 2;
    const rx = Math.min(W / 2 - 70, 30 + n * 8);
    const ry = Math.min(H / 2 - 80, 40 + n * 6);
    analysis.articles.forEach((a, i) => {
      const angle = (i / Math.max(n, 1)) * Math.PI * 2 - Math.PI / 2;
      map.set(a.id, { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) });
    });
    return map;
  }, [analysis.articles]);

  // 聚合条级边（同条对只画一条，记录成员 refKey）
  const selfRefKeys = useMemo(
    () => new Set(analysis.issues.filter((i) => i.type === 'self' && i.refKey).map((i) => i.refKey!)),
    [analysis.issues],
  );
  const edgeGroups = useMemo(() => {
    const map = new Map<
      string,
      { from: string; to: string; keys: string[]; selfProblem: boolean }
    >();
    for (const e of analysis.edges) {
      const k = `${e.sourceArticleId}>${e.targetArticleId}`;
      const g =
        map.get(k) ?? {
          from: e.sourceArticleId,
          to: e.targetArticleId,
          keys: [],
          selfProblem: false,
        };
      g.keys.push(e.refKey);
      if (selfRefKeys.has(e.refKey)) g.selfProblem = true;
      map.set(k, g);
    }
    // 条内相对引用（本条/前款等）不是问题，不作为自环展示；只保留绝对自指
    return [...map.values()].filter((g) => g.from !== g.to || g.selfProblem);
  }, [analysis.edges, selfRefKeys]);

  const brokenRefs = analysis.occurrences.filter((o) => o.resolution.status === 'broken');

  const hoveredKey = hl.hoverRefKey ?? hl.activeRefKey;
  const activeArticle = hl.activeNodeId
    ? analysis.placement[hl.activeNodeId]?.article.id
    : null;

  // 基于当前确认后的解析图计算引用影响（刷新仅重算并更新时间提示，结果始终来自最新分析）
  const impact: ImpactResult | null = useMemo(() => {
    void refreshNonce;
    return selectedId ? computeImpact(analysis, selectedId) : null;
  }, [analysis, selectedId, refreshNonce]);

  const selectedStillExists = selectedId
    ? analysis.articles.some((a) => a.id === selectedId)
    : true;
  const selectedArticle = selectedId
    ? analysis.articles.find((a) => a.id === selectedId) ?? null
    : null;

  const refresh = () => {
    setRefreshNonce((n) => n + 1);
    setRefreshedAt(Date.now());
  };

  const isPathEdge = (from: string, to: string): boolean => {
    if (!impact) return false;
    const df = impact.distances.get(from);
    const dt = impact.distances.get(to);
    return df !== undefined && dt !== undefined && df === dt + 1;
  };
  const isReachEdge = (from: string, to: string): boolean => {
    if (!impact) return false;
    return impact.distances.has(from) && impact.distances.has(to);
  };

  return (
    <div className="relation-view">
      <div className="graph-legend">
        <span><i className="dot edge-ok" /> 有效引用</span>
        <span><i className="dot edge-self" /> 自引用</span>
        <span><i className="dot edge-cycle" /> 循环</span>
        <span><i className="dot node-broken-dot" /> 条内含断链</span>
      </div>

      {analysis.articles.length === 0 ? (
        <div className="empty-hint">导入条款后在此查看引用关系图。</div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} className="graph-svg" role="img" aria-label="条级引用关系图">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />
            </marker>
            <marker id="arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#f59e0b" />
            </marker>
          </defs>

          {edgeGroups.map((g) => {
            const p1 = positions.get(g.from)!;
            const p2 = positions.get(g.to)!;
            const isSelf = g.from === g.to;
            const isHot = hoveredKey && g.keys.includes(hoveredKey);
            const inCycle = analysis.issues.some(
              (i) =>
                i.type === 'cycle' &&
                i.cycleNodeIds?.includes(g.from) &&
                i.cycleNodeIds?.includes(g.to),
            );
            const cls = isSelf ? 'edge-self' : inCycle ? 'edge-cycle' : 'edge-ok';
            const impactCls = isPathEdge(g.from, g.to)
              ? 'impact-path'
              : isReachEdge(g.from, g.to)
                ? 'impact-reach'
                : '';
            if (isSelf) {
              return (
                <path
                  key={`${g.from}-${g.to}`}
                  className={`graph-edge ${cls} ${impactCls} ${isHot ? 'hot' : ''}`}
                  d={`M ${p1.x} ${p1.y - 16} c -34 -8 -34 -44 0 -52`}
                  markerEnd="url(#arrow)"
                  onMouseEnter={() => highlighter.hoverRef(g.keys[0], [g.from])}
                  onMouseLeave={() => highlighter.hoverRef(null, null)}
                  onClick={() =>
                    highlighter.jumpTo(
                      analysis.edges.find((e) => e.refKey === g.keys[0])!.sourceNodeId,
                    )
                  }
                />
              );
            }
            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const len = Math.hypot(dx, dy) || 1;
            const gap = 22;
            const sx = p1.x + (dx / len) * gap;
            const sy = p1.y + (dy / len) * gap;
            const ex = p2.x - (dx / len) * gap;
            const ey = p2.y - (dy / len) * gap;
            // 双向边弯曲
            const reverse = edgeGroups.some((o) => o.from === g.to && o.to === g.from);
            const mx = (sx + ex) / 2 - (dy / len) * (reverse ? 26 : 0);
            const my = (sy + ey) / 2 + (dx / len) * (reverse ? 26 : 0);
            return (
              <path
                key={`${g.from}>${g.to}`}
                className={`graph-edge ${cls} ${impactCls} ${isHot ? 'hot' : ''}`}
                d={`M ${sx} ${sy} Q ${mx} ${my} ${ex} ${ey}`}
                markerEnd={isHot ? 'url(#arrow-hot)' : 'url(#arrow)'}
                onMouseEnter={() => highlighter.hoverRef(g.keys[0], [g.to])}
                onMouseLeave={() => highlighter.hoverRef(null, null)}
                onClick={() =>
                  highlighter.jumpTo(
                    analysis.edges.find((e) => e.refKey === g.keys[0])!.sourceNodeId,
                  )
                }
              />
            );
          })}

          {analysis.articles.map((a) => {
            const p = positions.get(a.id)!;
            const hasBroken = brokenRefs.some(
              (o) => analysis.placement[o.nodeId]?.article.id === a.id,
            );
            const inCycle = analysis.issues.some(
              (i) => i.type === 'cycle' && i.cycleNodeIds?.includes(a.id),
            );
            const cls = hasBroken
              ? 'node-broken'
              : inCycle
                ? 'node-cycle'
                : 'node-normal';
            return (
              <g
                key={a.id}
                className={`graph-node ${cls} ${activeArticle === a.id ? 'active' : ''} ${
                  selectedId === a.id ? 'selected' : ''
                } ${impact?.distances.has(a.id) && a.id !== selectedId ? 'impact-source' : ''}`}
                transform={`translate(${p.x}, ${p.y})`}
                onMouseEnter={() => highlighter.activateNode(a.id)}
                onMouseLeave={() => highlighter.activateNode('')}
                onClick={() => setSelectedId(a.id)}
              >
                <circle r={20} />
                <text textAnchor="middle" dy="4" className="graph-node-text">
                  {formatOrdinal(a.ordinal)}
                </text>
                <text textAnchor="middle" y={36} className="graph-node-label">
                  {shortArticleLabel(a.ordinal, a.suffix)}
                </text>
              </g>
            );
          })}
        </svg>
      )}

      {analysis.articles.length > 0 &&
        (selectedId ? (
          <ImpactBox
            impact={impact}
            selectedExists={selectedStillExists}
            selectedLabel={selectedArticle
              ? shortArticleLabel(selectedArticle.ordinal, selectedArticle.suffix)
              : '（已删除条款）'}
            refreshedAt={refreshedAt}
            onRefresh={refresh}
            onClear={() => {
              setSelectedId(null);
              setRefreshedAt(null);
            }}
            onLocateTarget={() => selectedArticle && highlighter.jumpTo(selectedId)}
          />
        ) : (
          <div className="impact-hint">
            点击关系图中的任一条款节点，对其进行<strong>引用影响分析</strong>
            （直接 / 间接引用该条款的源条款分层展示）。
          </div>
        ))}

      <div className="panel-footer">
        点击节点选中以分析引用影响；悬停节点可定位正文条目；悬停或点击边可跳转到产生引用的源句。
      </div>
    </div>
  );
}

// ---------- 引用影响分析结果面板 ----------

function ImpactBox({
  impact,
  selectedExists,
  selectedLabel,
  refreshedAt,
  onRefresh,
  onClear,
  onLocateTarget,
}: {
  impact: ImpactResult | null;
  selectedExists: boolean;
  selectedLabel: string;
  refreshedAt: number | null;
  onRefresh: () => void;
  onClear: () => void;
  onLocateTarget: () => void;
}) {
  const { store, highlighter } = useApp();
  const { analysis } = store.getSnapshot();

  // 点击结果行：跳回产生引用的源节点，并高亮该引用所在源句
  const jumpToSource = (refKey: string, sourceNodeId: string) => {
    const occ = analysis.occurrences.find((o) => o.key === refKey);
    const node = analysis.nodes[sourceNodeId];
    if (!occ || !node) {
      highlighter.jumpTo(sourceNodeId);
      return;
    }
    const sentence = locateSentence(node.text, occ.span.start, occ.span.end);
    highlighter.jumpTo(sourceNodeId, sentence, refKey);
  };

  return (
    <div className="impact-box" aria-label="引用影响分析">
      <div className="impact-head">
        <div className="impact-title">
          <span className="impact-target">🎯 {selectedLabel}</span>
          <button className="link-btn subtle small" onClick={onLocateTarget} disabled={!selectedExists}>
            跳到正文
          </button>
        </div>
        <div className="impact-actions">
          <button className="small" onClick={onRefresh} title="按当前确认后的解析图重新计算">
            ↻ 刷新
          </button>
          <button className="small" onClick={onClear} title="清空选择，不影响正文">
            ✕ 清空选择
          </button>
        </div>
      </div>

      {!selectedExists || !impact ? (
        <div className="impact-body empty-hint">
          所选条款在当前文档中已不存在，可重新选择节点或
          <button className="link-btn" onClick={onClear}>清空选择</button>。
        </div>
      ) : (
        <>
          <div className="impact-summary">
            共 <strong>{impact.total}</strong> 个源条款引用{selectedLabel}
            {impact.cycleArticleIds.size > 1 ? (
              <>
                ；其中 <strong className="impact-cycle-num">{impact.cycleArticleIds.size - 1}</strong> 个与其构成
                <span className="impact-cycle-tag">循环</span>
              </>
            ) : impact.cycleArticleIds.has(impact.targetId) ? (
              <>
                ；{selectedLabel}存在指向自身的<span className="impact-cycle-tag">自环引用</span>
              </>
            ) : null}
            {refreshedAt && <span className="impact-time">· 已刷新 {formatClock(refreshedAt)}</span>}
          </div>

          {impact.total === 0 ? (
            <div className="impact-body empty-hint">当前没有任何条款直接或间接引用{selectedLabel}。</div>
          ) : (
            <div className="impact-body">
              {impact.layers.map((layer) => (
                <div key={layer.distance} className="impact-layer">
                  <div className="impact-layer-head">
                    第 {layer.distance} 层 · {layer.distance === 1 ? '直接引用' : '间接引用'}
                    <span className="impact-layer-count">{layer.sources.length}</span>
                  </div>
                  {layer.sources.map((s) => {
                    const occ = analysis.occurrences.find((o) => o.key === s.viaEdge.refKey);
                    return (
                      <div
                        key={s.articleId}
                        className="impact-row"
                        role="button"
                        tabIndex={0}
                        title="点击跳回产生引用的正文"
                        onClick={() => jumpToSource(s.viaEdge.refKey, s.viaEdge.sourceNodeId)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            jumpToSource(s.viaEdge.refKey, s.viaEdge.sourceNodeId);
                          }
                        }}
                        onMouseEnter={() => highlighter.activateNode(s.articleId)}
                        onMouseLeave={() => highlighter.activateNode('')}
                      >
                        <span className="impact-row-label">{impactArticleLabel(analysis, s.articleId)}</span>
                        {s.inCycle && (
                          <span className="impact-cycle-tag" title="与所选条款处于同一循环路径（循环路径已去重）">
                            🔄 循环
                          </span>
                        )}
                        {occ && <span className="impact-row-raw">{occ.span.raw}</span>}
                        <span className="impact-row-go">↗</span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function formatClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
