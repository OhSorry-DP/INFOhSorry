// Remote HTTP recommendation requests are forwarded to the affinity Worker.
import { useEffect, useRef } from 'react';
import type { UserDpChart } from './emodeTargets';
import type { RecRequest } from './compute/recommendBridgeHandler';

export interface RecommendBridgeDeps {
  service: { query: (options: any, lane?: string) => Promise<any> } | null;
  targetService?: { query: (options: any, lane?: string) => Promise<any> } | null;
  ratingData: any;
  userRStar: number | null;
  baseStar: number | null;
  userCharts: UserDpChart[];
}

export function useRecommendBridge(deps: RecommendBridgeDeps): void {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  useEffect(() => {
    const api = (window as unknown as { infohsorry?: { recommend?: { onRequest?: (cb: (r: RecRequest) => void) => (() => void); respond?: (p: unknown) => void } } }).infohsorry;
    const rec = api?.recommend;
    if (!rec?.onRequest || !rec?.respond) return;
    let active = true;
    const isCurrent = (captured: RecommendBridgeDeps): boolean => {
      const current = depsRef.current;
      return current.service === captured.service && current.targetService === captured.targetService &&
        current.ratingData === captured.ratingData &&
        current.userCharts === captured.userCharts && current.baseStar === captured.baseStar &&
        current.userRStar === captured.userRStar;
    };
    const off = rec.onRequest((req: RecRequest) => {
      const captured = depsRef.current;
      const service = captured.service ?? (req.kind === 'targets' ? captured.targetService : null);
      void (async () => {
        try {
          if (!service) {
            if (req.kind !== 'meta') throw new Error('recCtx not ready (INF 창이 열려있고 추천 lib 로딩이 끝나야 함)');
            if (!active || !isCurrent(captured)) throw new Error('recommendation data changed');
            rec.respond!({ reqId: req.reqId, ok: true, result: {
              ready: false, coreVersion: null, baseStar: captured.baseStar, userRStar: captured.userRStar,
              practiceParents: null, practiceSubfeats: null, practiceSubfeatsHidden: null,
              practiceZasaDefault: null,
              targetsAvailable: captured.userRStar != null && !!captured.ratingData?.rateStar?.scale,
            } });
            return;
          }
          const result = await service.query({
            operation: req.kind === 'targets' && !captured.service ? 'targets' : 'bridge',
            layout: req.kind === 'targets' && !captured.service ? 'off' : req.params?.layout === 'on' ? 'on' : 'off',
            request: req,
            bridge: { baseStar: captured.baseStar, userRStar: captured.userRStar, userCharts: captured.userCharts },
          }, 'bridge:' + req.reqId);
          if (!active) return;
          if (!isCurrent(captured)) throw new Error('recommendation data changed');
          rec.respond!({ reqId: req.reqId, ok: true, result });
        } catch (e) {
          if (active) rec.respond!({ reqId: req.reqId, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      })();
    });
    return () => { active = false; off(); };
  }, []);
}
