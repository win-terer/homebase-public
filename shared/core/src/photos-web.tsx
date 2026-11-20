import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cacheGet, cacheSet, clearWebCache, primeRev } from "./web-cache.ts";

/**
 * 사진 첨부 — 화면 공용 (일정 편집·가계부 거래 줄). 서버는 host/src/worker/photos.ts.
 *
 * 올리기 전에 **브라우저에서 줄인다**: 긴 변 1600px JPEG(품질 0.82) + 긴 변 320px 썸네일.
 * 다시 그려서 인코딩하므로 원본·EXIF(촬영 위치 등)는 남지 않는다. 사용자 결정(2026-10-09): 원본 보관 안 함.
 */
export type PhotoApp = "calendar" | "ledger" | "todo";
export interface Photo {
  id: string;
  width: number | null;
  height: number | null;
}

const FULL_EDGE = 1600;
const THUMB_EDGE = 320;
const FULL_LIMIT = 1400 * 1024; // 서버 상한(1.5MB)보다 조금 아래 — 넘으면 품질을 낮춰 한 번 더

/**
 * 사진 API 주소. 손님 화면은 **다른 길**로 간다(`/api/guest/photos`) — 동거인에게는 그 길만 열려
 * 있고, 거기서는 '공유 카테고리 일정에 붙은 사진인가' 를 매번 다시 본다. 화면마다 번들이 따로라
 * (host/vite.config.ts) 한 페이지에 둘이 섞이지 않는다.
 */
let BASE = "/api/photos";
export const setPhotoBase = (base: string) => {
  BASE = base;
};

export const photoUrl = (id: string, thumb = false) => `${BASE}/file/${id}${thumb ? "?t=1" : ""}`;

async function getJson<T>(url: string, cached = true): Promise<T> {
  if (cached) {
    await primeRev();
    const hit = cacheGet(url);
    if (hit !== undefined) return hit as T;
  }
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `요청 실패 (${res.status})`);
  if (cached) cacheSet(url, body);
  return body as T;
}

async function send(url: string, init: RequestInit) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  // 데이터가 바뀌었으니 들고 있던 조회는 버린다 (다른 화면들의 request() 와 같은 규칙)
  clearWebCache();
  void primeRev();
  emit();
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `요청 실패 (${res.status})`);
  return body;
}

/**
 * 앱마다 '사진 붙은 항목 → 장수' 를 **한 번만** 받아 모든 줄이 나눠 쓴다(줄마다 부르면 줄 수만큼 왕복).
 * 사진을 올리거나 지우면 다시 받고 구독한 줄들에 알린다.
 */
const marksState: Partial<Record<PhotoApp, { data: Record<string, number>; p: Promise<void> | null; subs: Set<() => void> }>> = {};
const stateOf = (app: PhotoApp) => (marksState[app] ??= { data: {}, p: null, subs: new Set() });
function loadMarks(app: PhotoApp, force = false): Promise<void> {
  const st = stateOf(app);
  if (!st.p || force) {
    st.p = photoApi
      .marks(app)
      .then((r) => {
        st.data = r.marks;
        st.subs.forEach((f) => f());
      })
      .catch(() => {});
  }
  return st.p;
}
const emit = () => (Object.keys(marksState) as PhotoApp[]).forEach((app) => void loadMarks(app, true));

async function shrink(file: Blob, edge: number, quality: number): Promise<{ blob: Blob; w: number; h: number }> {
  // imageOrientation: 휴대폰 사진의 회전 정보를 반영해서 그린다 (EXIF 자체는 버린다)
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const s = Math.min(1, edge / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d");
  if (!ctx) throw new Error("이 브라우저에서는 사진을 줄일 수 없어요");
  ctx.fillStyle = "#fff"; // 투명한 PNG 는 흰 바탕으로
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, "image/jpeg", quality));
  if (!blob) throw new Error("사진을 줄이지 못했어요");
  return { blob, w, h };
}

export const photoApi = {
  list: (app: PhotoApp, ref: number | string) =>
    getJson<{ photos: Photo[]; max: number; enabled: boolean }>(`${BASE}?app=${app}&ref=${encodeURIComponent(String(ref))}`),
  marks: (app: PhotoApp) => getJson<{ marks: Record<string, number> }>(`${BASE}/marks?app=${app}`),
  async upload(app: PhotoApp, ref: number, file: File): Promise<{ id: string }> {
    let full;
    try {
      full = await shrink(file, FULL_EDGE, 0.82);
      if (full.blob.size > FULL_LIMIT) full = await shrink(file, FULL_EDGE, 0.68);
    } catch {
      throw new Error(`${file.name || "사진"}: 열 수 없는 형식이에요 (JPEG·PNG·WebP, 아이폰은 '가장 호환성 높은' 형식)`);
    }
    const thumb = await shrink(full.blob, THUMB_EDGE, 0.75);
    const form = new FormData();
    form.set("app", app);
    form.set("ref", String(ref));
    form.set("full", full.blob, "full.jpg");
    form.set("thumb", thumb.blob, "thumb.jpg");
    form.set("w", String(full.w));
    form.set("h", String(full.h));
    return send(BASE, { method: "POST", body: form }) as Promise<{ id: string }>;
  },
  remove: (id: string) => send(`${BASE}/${id}`, { method: "DELETE" }),
  /** 다른 항목으로 옮기기 (가계부 '옮기지 못한 메모' 붙이기) */
  move: (app: PhotoApp, from: string, to: number) =>
    send(`${BASE}/move`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app, from, to }) }),
  /** 'lost:…' 로 남겨 둔 사진 버리기 */
  drop: (app: PhotoApp, ref: string) =>
    send(`${BASE}/drop`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app, ref }) }),
};

/**
 * 클립보드 붙여넣기 (Ctrl+V / ⌘V) — 캡처한 영수증·예약 화면을 바로 붙인다 (사용자 요청 2026-10-09).
 *
 * 어디에 붙일지는 `data-photo-target="앱:id"` 가 달린 요소로 정한다: 붙여넣은 곳(포커스) 안에 있으면 그것,
 * 아니면 **마지막으로 누른 곳**. 가계부는 한 화면에 거래 줄이 여럿이라 "방금 누른 줄" 이 자연스럽다.
 * 그 항목의 사진 줄이 떠 있으면 그 줄이 받아서 올리는 중 표시·오류를 보여 주고, 없으면(사진 없는 거래 줄)
 * 바로 올린 뒤 표시를 다시 읽어 사진 줄이 나타나게 한다.
 * **메모 칸에 커서가 있어도** 클립보드에 이미지가 있으면 사진으로 붙인다(사용자 요청 2026-10-09). 이때 클립보드에
 * 글자도 같이 있으면 글자는 원래대로 메모에 들어가게 둔다(preventDefault 안 함) — 둘 다 잃지 않게.
 */
const strips = new Map<string, (files: File[]) => void>();
let lastPressed: Element | null = null;
if (typeof document !== "undefined") {
  document.addEventListener("pointerdown", (e) => (lastPressed = e.target instanceof Element ? e.target : null), true);
  document.addEventListener("paste", (e) => {
    const data = e.clipboardData;
    const files = data ? [...data.files].filter((f) => f.type.startsWith("image/")) : [];
    if (!files.length) return;
    const here = e.target instanceof Element ? e.target : null;
    const keepText = Boolean(here?.closest("input, textarea, [contenteditable]") && data?.types.includes("text/plain"));
    const host = here?.closest("[data-photo-target]") ?? (lastPressed?.isConnected ? lastPressed.closest("[data-photo-target]") : null);
    const target = host?.getAttribute("data-photo-target");
    // 앱 이름은 PhotoApp 과 같아야 한다 — 빠뜨리면 그 화면에서 붙여넣기만 조용히 안 된다
    const m = target?.match(/^(calendar|ledger|todo):(\d+)$/);
    if (!m) return;
    if (!keepText) e.preventDefault();
    const strip = strips.get(target!);
    if (strip) return strip(files);
    void (async () => {
      for (const f of files.slice(0, 3)) {
        try {
          await photoApi.upload(m[1] as PhotoApp, Number(m[2]), f);
        } catch (err) {
          alert((err as Error).message);
          break;
        }
      }
    })();
  });
}

/**
 * 달력 줄의 작은 사진 표시 (사진이 붙은 일정·거래). 칸이 좁아서 글자 대신 카메라 모양 하나만,
 * 색은 줄 글자색을 따라 흐리게 — 금액·이름보다 튀지 않게.
 */
export function PhotoMark({ n }: { n?: number }) {
  if (!n) return null;
  return (
    <svg className="hb-photo-mark" viewBox="0 0 16 16" role="img" aria-label={`사진 ${n}장`}>
      <title>{`사진 ${n}장`}</title>
      <path d="M2 5.6A1.6 1.6 0 0 1 3.6 4h1.5l1-1.5h3.8l1 1.5h1.5A1.6 1.6 0 0 1 14 5.6v5.8a1.6 1.6 0 0 1-1.6 1.6H3.6A1.6 1.6 0 0 1 2 11.4z" />
      <circle cx="8" cy="8.4" r="2.3" />
    </svg>
  );
}

/** 앱 전체에서 사진이 붙은 항목 → 장수. 사진을 올리거나 지우면 다시 읽는다 */
export function usePhotoMarks(app: PhotoApp): Record<string, number> {
  const st = stateOf(app);
  const [marks, setMarks] = useState<Record<string, number>>(st.data);
  useEffect(() => {
    const on = () => setMarks(stateOf(app).data);
    stateOf(app).subs.add(on);
    void loadMarks(app).then(on);
    return () => void stateOf(app).subs.delete(on);
  }, [app]);
  return marks;
}

/**
 * 사진 줄: 썸네일 + [＋ 사진] + 크게 보기. 항목 하나에 max 장(서버가 알려 줌, 3).
 * `autoOpenPicker`: 처음 그릴 때 파일 고르기를 바로 연다 (줄의 📷 단추로 열었을 때)
 */
export function PhotoStrip({
  app,
  refId,
  className = "",
  autoOpenPicker = false,
  readOnly = false,
}: {
  app: PhotoApp;
  refId: number;
  className?: string;
  autoOpenPicker?: boolean;
  /**
   * **보기만.** 붙인 사진이 있으면 보여 주고, 없으면 아무것도 그리지 않는다.
   * 보기 화면에 '＋ 사진 / 또는 Ctrl+V' 가 떠 있으면 붙일 자리인지 본 것인지 헷갈린다
   * (사용자 지적 2026-11-20) — 붙이는 건 고치기 화면에서만.
   */
  readOnly?: boolean;
}) {
  const [photos, setPhotos] = useState<Photo[] | null>(null);
  const [max, setMax] = useState(3);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const r = await photoApi.list(app, refId);
    setPhotos(r.photos);
    setMax(r.max);
    setEnabled(r.enabled);
  }, [app, refId]);

  useEffect(() => {
    void load().catch((e) => setError((e as Error).message));
  }, [load]);
  useEffect(() => {
    if (autoOpenPicker) input.current?.click();
  }, [autoOpenPicker]);

  const add = async (files: FileList | File[] | null) => {
    if (!files?.length) return;
    setError(null);
    const room = Math.max(0, max - (photos?.length ?? 0));
    const list = [...files].slice(0, room);
    if (files.length > room) setError(`사진은 ${max}장까지예요 — 앞의 ${room}장만 올려요`);
    setBusy(list.length);
    for (const f of list) {
      try {
        await photoApi.upload(app, refId, f);
      } catch (e) {
        setError((e as Error).message);
      }
      setBusy((n) => n - 1);
    }
    await load().catch(() => {});
  };

  // 붙여넣기 받기 — 최신 add 를 부르도록 매번 다시 건다. 보기만 할 때는 안 받는다
  const key = `${app}:${refId}`;
  useEffect(() => {
    if (readOnly) return;
    strips.set(key, (files) => void add(files));
    return () => void (strips.get(key) && strips.delete(key));
  });

  const remove = async (id: string) => {
    if (!confirm("이 사진을 지울까요?")) return;
    try {
      await photoApi.remove(id);
      setView(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!photos) return null;
  if (readOnly && !photos.length) return null; // 보기 화면에 빈 자리를 만들지 않는다
  const canAdd = !readOnly && enabled && photos.length + busy < max;
  return (
    /* 보기만 할 때는 **붙여넣기 표적 자체를 달지 않는다.** 달아 두면 붙여넣기가 이 자리를
       찾아내 등록된 strip 이 없다고 곧장 올려 버린다 — 여러 줄을 펼쳐 둔 채 Ctrl+V 하면
       어디로 들어갔는지 알 수 없다 (사용자 지적 2026-11-20) */
    <div className={`hb-photos ${className}`} data-photo-target={readOnly ? undefined : key}>
      {photos.map((p, i) => (
        <span key={p.id} className="hb-photo">
          <button type="button" className="hb-photo-img" onClick={() => setView(i)} aria-label={`사진 ${i + 1} 크게 보기`}>
            <img src={photoUrl(p.id, true)} alt="" loading="lazy" />
          </button>
          {!readOnly && (
            <button type="button" className="hb-photo-del" onClick={() => void remove(p.id)} aria-label="사진 지우기" title="지우기">
              ✕
            </button>
          )}
        </span>
      ))}
      {Array.from({ length: busy }, (_, i) => (
        <span key={`b${i}`} className="hb-photo is-busy" aria-label="올리는 중">
          <span className="hb-photo-spin" />
        </span>
      ))}
      {canAdd && (
        <button type="button" className="hb-photo-add" onClick={() => input.current?.click()} title={`사진 붙이기 (${max}장까지) — 캡처는 Ctrl+V 로 붙여넣어도 돼요`}>
          ＋ 사진
          <span className="hb-photo-hint">또는 Ctrl+V</span>
        </button>
      )}
      {!enabled && !readOnly && <span className="hb-muted">사진 기능이 아직 켜져 있지 않아요</span>}
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          void add(e.target.files);
          e.target.value = "";
        }}
      />
      {error && <span className="hb-error hb-photo-err">{error}</span>}
      {view !== null && photos[view] && (
        <PhotoViewer photos={photos} index={view} onIndex={setView} onClose={() => setView(null)} onDelete={readOnly ? undefined : (id) => void remove(id)} />
      )}
    </div>
  );
}

function PhotoViewer({
  photos,
  index,
  onIndex,
  onClose,
  onDelete,
}: {
  photos: Photo[];
  index: number;
  onIndex(i: number): void;
  onClose(): void;
  /** 없으면 보기만 — 지우기 버튼을 안 그린다 */
  onDelete?: (id: string) => void;
}) {
  const p = photos[index]!;
  useEffect(() => {
    // 붙잡기 단계에서 먼저 받아 preventDefault — 뒤의 날짜 팝업·일정 폼이 Esc 로 같이 닫히지 않게
    // (그쪽은 `!e.defaultPrevented` 일 때만 닫는다)
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      else if (e.key === "ArrowRight" && index < photos.length - 1) onIndex(index + 1);
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [index, photos.length, onClose, onIndex]);
  // body 에 그린다 — 날짜 팝업 안의 transform·overflow 에 갇히지 않게. 바깥 클릭 판정에서는 `.hb-viewer` 를 팝업의 일부로 친다
  return createPortal(
    <div className="hb-viewer" role="dialog" aria-label="사진" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <img src={photoUrl(p.id)} alt="" />
      <div className="hb-viewer-bar">
        <span>
          {index + 1} / {photos.length}
        </span>
        {index > 0 && (
          <button type="button" onClick={() => onIndex(index - 1)}>
            ← 이전
          </button>
        )}
        {index < photos.length - 1 && (
          <button type="button" onClick={() => onIndex(index + 1)}>
            다음 →
          </button>
        )}
        <a href={photoUrl(p.id)} download={`photo-${p.id.slice(0, 8)}.jpg`}>
          저장
        </a>
        {onDelete && (
          <button type="button" onClick={() => onDelete(p.id)}>
            지우기
          </button>
        )}
        <button type="button" onClick={onClose}>
          닫기 ✕
        </button>
      </div>
    </div>,
    document.body,
  );
}
