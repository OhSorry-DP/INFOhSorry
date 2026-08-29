"""
title: OhSorry DP Coach
author: yenkara
version: 0.1.0
license: MIT
description: >
  IIDX INFINITAS DP 코치 도구. 로컬 INF 앱(ohsorry.local)의 /api/me 와 /api/recommend 로
  별값·추천곡(클리어/연습/v3 사다리/등급 목표)을, 오소리 CDN 덤프(data.iidx.in)로 성향 리포트·
  패턴 분석을 가져온다. 추천 로직은 오소리 코어 recommend.js 를 그대로 쓴다(웹 iidx.in 과 동일).
requirements: requests
"""

import json
from typing import Optional

import requests
from pydantic import BaseModel, Field

# 오소리 성향/분석 덤프 CDN — INF 업로드마다 웹훅이 재생성한다. 웹 iidx.in 의 Report 탭과 같은 소스.
_CDN_BASE = "https://data.iidx.in/"


def _clip(text: str, limit: int = 6000) -> str:
    return text if len(text) <= limit else text[:limit] + "\n...(생략)"


class Tools:
    class Valves(BaseModel):
        base_url: str = Field(
            default="http://192.168.0.132:3000",
            description="INF 앱이 뜬 PC 주소. OpenWebUI 가 Docker면 mDNS(ohsorry.local)가 안 풀리므로 LAN IP 를 쓴다.",
        )
        timeout_sec: int = Field(default=20, description="HTTP 타임아웃(초)")

    def __init__(self):
        self.valves = self.Valves()
        self._iidx_id: Optional[str] = None

    # ── 내부 헬퍼 ──────────────────────────────────────────────
    def _get(self, path: str) -> dict:
        r = requests.get(self.valves.base_url + path, timeout=self.valves.timeout_sec)
        r.raise_for_status()
        return r.json()

    def _my_iidx_id(self) -> str:
        if not self._iidx_id:
            me = self._get("/api/me")
            self._iidx_id = (me.get("iidx_id") or "").replace("-", "").strip()
        if not self._iidx_id:
            raise RuntimeError("IIDX ID 를 못 읽었습니다 (INF 앱에서 게임 로그인 상태여야 함).")
        return self._iidx_id

    def _cdn_dump(self) -> dict:
        """오소리 CDN 유저 덤프 (persona / osPattern / radars). 미덤프면 빈 dict."""
        iid = self._my_iidx_id()
        r = requests.get(_CDN_BASE + "user/" + iid + ".json", timeout=self.valves.timeout_sec)
        if r.status_code == 404:
            raise RuntimeError("아직 성향 리포트가 없습니다 (INF 로 점수 업로드 후 생성됩니다).")
        r.raise_for_status()
        return r.json()

    def _recommend(self, kind: str, params: Optional[dict] = None) -> dict:
        r = requests.post(
            self.valves.base_url + "/api/recommend",
            json={"kind": kind, "params": params or {}},
            timeout=self.valves.timeout_sec,
        )
        if r.status_code == 503:
            raise RuntimeError(
                "INF 앱이 아직 준비되지 않았습니다 (창이 열려 있고 추천 데이터 로딩이 끝나야 함). 잠시 후 다시 시도하세요."
            )
        r.raise_for_status()
        body = r.json()
        if "error" in body:
            raise RuntimeError(body["error"])
        return body.get("result", body)

    # ── 도구 ─────────────────────────────────────────────────
    def get_profile(self, **kwargs) -> str:
        """
        현재 플레이어의 오소리 프로필을 가져온다.
        별값(star_estimate), 점수 별값(r_star), SP/DP 단위, 노트레이더 6지표,
        그리고 보유 차트 수를 요약해서 반환한다. 실력 분석의 출발점.
        """
        try:
            me = self._get("/api/me")
        except Exception as e:  # noqa: BLE001
            return f"프로필을 가져오지 못했습니다: {e}"
        charts = me.get("charts_json") or []
        sp_charts = me.get("sp_charts_json") or []
        radar = me.get("notes_radar") or {}
        summary = {
            "dj_name": me.get("dj_name"),
            "iidx_id": me.get("iidx_id"),
            "star_estimate": me.get("star_estimate"),
            "native_star": me.get("native_star"),
            "r_star": me.get("r_star"),
            "sp_rank": me.get("sp_rank"),
            "dp_rank": me.get("dp_rank"),
            "sp_star": me.get("sp_star"),
            "dp_chart_count": len(charts),
            "sp_chart_count": len(sp_charts),
            "notes_radar_dp": radar.get("dp"),
            "notes_radar_sp": radar.get("sp"),
        }
        return _clip(json.dumps(summary, ensure_ascii=False, indent=2))

    def list_practice_features(self, **kwargs) -> str:
        """
        연습곡 추천(recommend_practice_songs)에서 쓸 수 있는 피처 목록과 코어 버전을 가져온다.
        practiceParents(1차) / practiceSubfeats(2차 세부축) 를 그대로 반환한다.
        연습곡을 추천하기 전에 유효한 feature 이름을 확인하려면 이걸 먼저 호출한다.
        """
        try:
            meta = self._recommend("meta")
        except Exception as e:  # noqa: BLE001
            return f"메타 정보를 가져오지 못했습니다: {e}"
        return _clip(json.dumps(meta, ensure_ascii=False, indent=2))

    def get_persona(self, **kwargs) -> str:
        """
        플레이어의 오소리 성향 리포트(persona)를 가져온다. 웹 iidx.in Report 탭과 같은 것.
        한 줄 요약(oneLiner) + 서사형 설명(prose) + 태그(tags) + 헤드라인(head).
        "나 어떤 플레이어야 / 내 스타일 / 성향" 류 질문에 쓴다.
        """
        try:
            d = self._cdn_dump()
        except Exception as e:  # noqa: BLE001
            return f"성향 리포트를 가져오지 못했습니다: {e}"
        p = d.get("persona") or {}
        if not p.get("prose"):
            return "성향 리포트가 아직 없습니다 (표본 부족이거나 업로드 후 미생성)."
        out = {
            "head": p.get("head"),
            "oneLiner": p.get("oneLiner"),
            "prose": p.get("prose"),
            "tags": p.get("tags"),
            "nCharts": p.get("nCharts"),
            "generatedAt": p.get("_v"),
        }
        return _clip(json.dumps(out, ensure_ascii=False, indent=2))

    def get_pattern_analysis(self, **kwargs) -> str:
        """
        플레이어의 패턴 분석을 가져온다. 약점/강점 파악은 게임 노트레이더가 아니라 이걸 근거로 삼는다.
        persona.report(피처별 강함/약함 σ 값 + 배치·개인차·무리·BPM 구간 분석) + osPattern(DP 피처 스코어
        원값 notes/chord/peak/charge/scratch/soflan/phrase/jack/trill/rand)을 반환한다.
        "내 약점 / 강점 / 뭘 연습해야 / 분석해줘" 류에 쓴다.
        """
        try:
            d = self._cdn_dump()
        except Exception as e:  # noqa: BLE001
            return f"패턴 분석을 가져오지 못했습니다: {e}"
        p = d.get("persona") or {}
        # osPattern — play_style 1 = DP (0 = SP).
        dp_scores = None
        for row in d.get("osPattern") or []:
            if row.get("play_style") == 1:
                dp_scores = {
                    k: row.get(k)
                    for k in ("notes", "chord", "peak", "charge", "scratch",
                              "soflan", "phrase", "jack", "trill", "rand")
                }
                break
        out = {
            "report": p.get("report"),
            "oneLiner": p.get("oneLiner"),
            "tags": p.get("tags"),
            "dp_feature_scores": dp_scores,
            "generatedAt": p.get("_v"),
            "note": "report 의 +/- 값은 본인 평균 대비 σ. dp_feature_scores 는 절대 스코어(높을수록 강함).",
        }
        return _clip(json.dumps(out, ensure_ascii=False, indent=2))

    def recommend_clear_songs(
        self,
        stage: str = "ec",
        base_star: Optional[float] = None,
        level_mode: str = "lv11+12",
        layout: str = "off",
        limit: int = 10,
        **kwargs,
    ) -> str:
        """
        클리어(램프) 추천곡을 가져온다. 오소리 코어 buildRecs 결과.
        :param stage: 목표 램프 — 'ec'(이지) / 'hc'(하드) / 'exh'(엑스하드). 생략 시 ec.
        :param base_star: 기준 실력 별값. 생략하면 플레이어의 현재 별값을 자동 사용. 더 쉬운/어려운 곡을 원하면 조정.
        :param level_mode: 'lv11+12'(기본) 또는 'lv12'(12만).
        :param layout: 배치 추천 — 'on'이면 8배치 중 최적, 'off'(기본)이면 정규 배치.
        :param limit: 최대 곡 수(기본 10).
        """
        params = {"stage": stage, "levelMode": level_mode, "layout": layout, "limit": limit}
        if base_star is not None:
            params["baseStar"] = base_star
        try:
            res = self._recommend("clear", params)
        except Exception as e:  # noqa: BLE001
            return f"클리어 추천을 가져오지 못했습니다: {e}"
        return _clip(json.dumps(res, ensure_ascii=False, indent=2))

    def recommend_practice_songs(
        self,
        feature: str = "all",
        strength: int = 1,
        hand_mode: str = "both",
        base_star: Optional[float] = None,
        layout: str = "off",
        top_n: int = 5,
        **kwargs,
    ) -> str:
        """
        약점 기반 연습곡을 가져온다. 오소리 코어 buildWeaknessRecs 결과.
        :param feature: 연습할 피처. 'all'(건반 종합) 또는 개별 — NOTES/CHORD/PEAK/PHRASE/JACK/TRILL/RAND(건반),
                        CHARGE/SCRATCH/SOF-LAN(개인차), HANDS(양손), 또는 2차 세부축(CN_SOLO, TRILL_SPEED 등).
                        유효값은 list_practice_features 로 확인.
        :param strength: 난이도 강도 1(기본)~3. 높을수록 어려운 곡.
        :param hand_mode: 'both'(기본) / 'left'(왼손 위주) / 'right'(오른손 위주).
        :param base_star: 기준 실력 별값. 생략 시 자동.
        :param layout: 배치 추천 'on'/'off'(기본).
        :param top_n: 곡 수(기본 5).
        """
        params = {
            "feature": feature,
            "strength": strength,
            "handMode": hand_mode,
            "layout": layout,
            "topN": top_n,
        }
        if base_star is not None:
            params["baseStar"] = base_star
        try:
            res = self._recommend("practice", params)
        except Exception as e:  # noqa: BLE001
            return f"연습곡 추천을 가져오지 못했습니다: {e}"
        return _clip(json.dumps(res, ensure_ascii=False, indent=2))

    def recommend_ladder(
        self,
        preset: str = "normal",
        base_star: Optional[float] = None,
        top_n: int = 5,
        **kwargs,
    ) -> str:
        """
        추천곡 v3 (est축 사다리) 를 가져온다. '실력 다지기 / 목표 T1 / 목표 T2' 3섹션.
        오소리 코어 buildEstLadder 결과. 단계적으로 실력을 올리는 로드맵용.
        :param preset: 'light'(가볍게) / 'normal'(적당히, 기본) / 'hard'(빡세게) — 눈금 간격.
        :param base_star: 기준 실력 별값. 생략 시 자동.
        :param top_n: 섹션당 곡 수(기본 5).
        """
        params = {"preset": preset, "topN": top_n}
        if base_star is not None:
            params["baseStar"] = base_star
        try:
            res = self._recommend("ladder", params)
        except Exception as e:  # noqa: BLE001
            return f"v3 사다리 추천을 가져오지 못했습니다: {e}"
        return _clip(json.dumps(res, ensure_ascii=False, indent=2))

    def recommend_grade_target(self, grade: str = "aa", limit: int = 15, **kwargs) -> str:
        """
        E모드 등급 목표 폴더를 가져온다 — 지금 점수를 조금만 올리면 다음 등급을 딸 수 있는 곡.
        점수 별값(r_star) 기준. 웹 iidx.in 의 'A/AA/AAA/MAX− 목표' 폴더와 동일.
        :param grade: 목표 등급 — 'a' / 'aa'(기본) / 'aaa' / 'maxm'(MAX−). 'all'이면 4개 다.
        :param limit: 등급당 최대 곡 수(기본 15).
        """
        params = {"grade": grade, "limit": limit}
        try:
            res = self._recommend("targets", params)
        except Exception as e:  # noqa: BLE001
            return f"등급 목표를 가져오지 못했습니다: {e}"
        if isinstance(res, dict) and not res.get("available", True):
            return "등급 목표를 계산할 수 없습니다 (점수 별값 r★ 미산출 — DP 플레이 기록이 더 필요)."
        return _clip(json.dumps(res, ensure_ascii=False, indent=2))
