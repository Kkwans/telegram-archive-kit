import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Check, Folder, FolderPlus, ImagePlus, Palette, Pencil, RotateCcw, Search, Trash2, Type, Upload, X } from "lucide-react";
import { ConfirmDialog } from "./ConfirmDialog";
import { Select } from "./Select";
import { call } from "./rpc";
import { bytes } from "./format";
import { chatDisplayName } from "./chatDisplay";
import { AVATAR_COLOR_PRESETS, ChatAvatar, avatarBackground, type LocalChatAvatar } from "./ChatAvatar";
import type { ChatGroup, ChatRow } from "./types";
import "./ChatOrganizationDialog.css";

const AVATAR_FONT_OPTIONS = [
  { value: "", label: "跟随系统" },
  { value: "Microsoft YaHei", label: "微软雅黑" },
  { value: "Microsoft YaHei UI", label: "微软雅黑 UI" },
  { value: "Segoe UI", label: "Segoe UI" },
  { value: "DengXian", label: "等线" },
  { value: "SimSun", label: "宋体" },
  { value: "KaiTi", label: "楷体" },
  { value: "Arial", label: "Arial" },
] as const;

function readAvatarDimensions(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52) {
    return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0x01 || marker === 0xd8 || marker === 0xd9) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset, false);
      if (length < 2 || offset + length > bytes.length) break;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { width: view.getUint16(offset + 5, false), height: view.getUint16(offset + 3, false) };
      }
      offset += length;
    }
  }
  throw new Error("头像仅支持 PNG 或 JPG 图片");
}

type AvatarImageInfo = { source: string; width: number; height: number };
type AvatarCrop = { zoom: number; x: number; y: number };

function clampAvatarCrop(image: AvatarImageInfo, crop: AvatarCrop): AvatarCrop {
  const zoom = Math.max(1, Math.min(3, crop.zoom));
  const scale = Math.max(512 / image.width, 512 / image.height) * zoom;
  const maxX = Math.max(0, (image.width * scale - 512) / 2);
  const maxY = Math.max(0, (image.height * scale - 512) / 2);
  return { zoom, x: Math.max(-maxX, Math.min(maxX, crop.x)), y: Math.max(-maxY, Math.min(maxY, crop.y)) };
}

async function loadAvatarImage(source: string) {
  const image = new Image();
  image.src = source;
  await image.decode();
  return image;
}

async function readAvatarFile(file: File): Promise<AvatarImageInfo> {
  if (!/\.(png|jpe?g)$/i.test(file.name) && file.type !== "image/png" && file.type !== "image/jpeg") throw new Error("请选择 PNG 或 JPG 图片");
  if (file.size > 10 * 1024 * 1024) throw new Error("图片不能超过 10 MB");
  const buffer = await file.arrayBuffer();
  const { width, height } = readAvatarDimensions(buffer);
  if (width <= 0 || height <= 0 || width > 8192 || height > 8192 || width * height > 12_000_000) throw new Error("图片尺寸过大，请选择更小的图片");
  const source = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("图片读取失败"));
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
  try {
    const image = await loadAvatarImage(source);
    return { source, width: image.naturalWidth, height: image.naturalHeight };
  } catch {
    throw new Error("图片无法解析，请换一张 PNG 或 JPG 图片");
  }
}

async function cropAvatarImage(image: AvatarImageInfo, crop: AvatarCrop) {
  const source = await loadAvatarImage(image.source);
  const next = clampAvatarCrop(image, crop);
  const scale = Math.max(512 / image.width, 512 / image.height) * next.zoom;
  const width = image.width * scale;
  const height = image.height * scale;
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前环境无法处理图片");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, 512, 512);
  context.drawImage(source, (512 - width) / 2 + next.x, (512 - height) / 2 + next.y, width, height);
  return canvas.toDataURL("image/jpeg", 0.9);
}

export function ChatOrganizationDialog({ chats, groups, avatars, libraryKey, refresh, onClose, toast }: {
  chats: ChatRow[];
  groups: ChatGroup[];
  avatars: Record<string, LocalChatAvatar>;
  libraryKey: string;
  refresh: () => void;
  onClose: () => void;
  toast: (message: string, error?: boolean) => void;
}) {
  const [filter, setFilter] = useState("*");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [destination, setDestination] = useState("");
  const [newGroup, setNewGroup] = useState("");
  const [renameId, setRenameId] = useState("");
  const [renameName, setRenameName] = useState("");
  const [aliasSlug, setAliasSlug] = useState("");
  const [aliasName, setAliasName] = useState("");
  const [avatarChat, setAvatarChat] = useState<ChatRow | null>(null);
  const [avatarMode, setAvatarMode] = useState<"default" | "color" | "image">("default");
  const [avatarColor, setAvatarColor] = useState<string>(AVATAR_COLOR_PRESETS[0].value);
  const [avatarFontFamily, setAvatarFontFamily] = useState("");
  const [avatarFontSize, setAvatarFontSize] = useState(24);
  const [avatarFontColor, setAvatarFontColor] = useState("#FFFFFF");
  const [avatarFontWeight, setAvatarFontWeight] = useState(650);
  const [avatarData, setAvatarData] = useState("");
  const [avatarImage, setAvatarImage] = useState<AvatarImageInfo | null>(null);
  const [cropZoom, setCropZoom] = useState(1);
  const [cropOffset, setCropOffset] = useState({ x: 0, y: 0 });
  const [avatarName, setAvatarName] = useState("");
  const [avatarError, setAvatarError] = useState("");
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarFileBusy, setAvatarFileBusy] = useState(false);
  const [deleteGroup, setDeleteGroup] = useState<ChatGroup | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [dragTarget, setDragTarget] = useState<string | null>(null);
  const dragging = useRef<string[]>([]);
  const search = useRef<HTMLInputElement>(null);
  const selectAll = useRef<HTMLInputElement>(null);
  const avatarFileInput = useRef<HTMLInputElement>(null);
  const avatarDialog = useRef<HTMLDivElement>(null);
  const avatarSelection = useRef(0);
  const cropStage = useRef<HTMLDivElement>(null);
  const cropDrag = useRef<{ pointerId: number; startX: number; startY: number; x: number; y: number } | null>(null);

  useEffect(() => {
    const previous = document.activeElement;
    search.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);

  useEffect(() => {
    if (!avatarChat) return;
    const previous = document.activeElement;
    avatarDialog.current?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [avatarChat]);

  useEffect(() => {
    if (avatarChat && (avatarBusy || avatarFileBusy)) avatarDialog.current?.focus({ preventScroll: true });
  }, [avatarChat, avatarBusy, avatarFileBusy]);

  const openAvatar = (chat: ChatRow) => {
    avatarSelection.current++;
    setAvatarFileBusy(false);
    setAvatarChat(chat);
    setAvatarMode(chat.avatarFile ? "image" : chat.avatarColor ? "color" : "default");
    setAvatarColor(chat.avatarColor || AVATAR_COLOR_PRESETS[0].value);
    setAvatarFontFamily(chat.avatarFont || "");
    setAvatarFontSize(chat.avatarSize || 24);
    setAvatarFontColor(chat.avatarInk || "#FFFFFF");
    setAvatarFontWeight(chat.avatarWeight || 650);
    setAvatarData("");
    setAvatarImage(null);
    setCropZoom(1);
    setCropOffset({ x: 0, y: 0 });
    setAvatarName("");
    setAvatarError("");
  };

  const resetAvatarFont = () => {
    setAvatarFontFamily("");
    setAvatarFontSize(24);
    setAvatarFontColor("#FFFFFF");
    setAvatarFontWeight(650);
  };

  const hasCustomFont = () => avatarFontFamily !== "" || avatarFontSize !== 24 || avatarFontColor.toUpperCase() !== "#FFFFFF" || avatarFontWeight !== 650;

  const saveAvatar = async () => {
    if (!avatarChat || avatarBusy || avatarFileBusy || avatarMode === "image" && !avatarImage && !avatarChat.avatarFile) return;
    setAvatarBusy(true);
    setAvatarError("");
    const customFont = hasCustomFont();
    try {
      const imageData = avatarMode === "image" && avatarImage
        ? await cropAvatarImage(avatarImage, { zoom: cropZoom, x: cropOffset.x, y: cropOffset.y })
        : avatarData;
      await call("editChatOrganization", {
        libraryKey,
        action: "avatar",
        slug: avatarChat.slug,
        avatarColor: avatarMode === "color" ? avatarColor : "",
        avatarData: avatarMode === "image" ? imageData : "",
        avatarFont: customFont ? avatarFontFamily : "",
        avatarSize: customFont ? avatarFontSize : 0,
        avatarInk: customFont ? avatarFontColor : "",
        avatarWeight: customFont ? avatarFontWeight : 0,
        keepAvatar: avatarMode === "image" && !avatarImage,
      });
      refresh();
      toast("聊天头像已更新");
      setAvatarChat(null);
    } catch (reason) {
      setAvatarError((reason as Error).message);
    } finally {
      setAvatarBusy(false);
    }
  };

  const selectAvatarFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || avatarFileBusy) return;
    const selection = ++avatarSelection.current;
    setAvatarFileBusy(true);
    setAvatarError("");
    setAvatarData("");
    setAvatarImage(null);
    setAvatarName("");
    setCropZoom(1);
    setCropOffset({ x: 0, y: 0 });
    try {
      const image = await readAvatarFile(file);
      const preview = await cropAvatarImage(image, { zoom: 1, x: 0, y: 0 });
      if (selection !== avatarSelection.current) return;
      setAvatarImage(image);
      setAvatarData(preview);
      setAvatarName(file.name);
      setAvatarMode("image");
    } catch (reason) {
      if (selection === avatarSelection.current) setAvatarError((reason as Error).message);
    } finally {
      if (selection === avatarSelection.current) setAvatarFileBusy(false);
    }
  };

  const updateCropZoom = (zoom: number) => {
    if (!avatarImage) return;
    const next = clampAvatarCrop(avatarImage, { zoom, x: cropOffset.x, y: cropOffset.y });
    setCropZoom(next.zoom);
    setCropOffset({ x: next.x, y: next.y });
  };

  const resetCrop = () => {
    setCropZoom(1);
    setCropOffset({ x: 0, y: 0 });
  };

  const startCropDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!avatarImage || avatarFileBusy) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    cropDrag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: cropOffset.x, y: cropOffset.y };
  };

  const moveCropDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = cropDrag.current;
    if (!drag || !avatarImage || drag.pointerId !== event.pointerId) return;
    const size = cropStage.current?.clientWidth || 1;
    const next = clampAvatarCrop(avatarImage, {
      zoom: cropZoom,
      x: drag.x + (event.clientX - drag.startX) * 512 / size,
      y: drag.y + (event.clientY - drag.startY) * 512 / size,
    });
    setCropOffset({ x: next.x, y: next.y });
  };

  const endCropDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (cropDrag.current?.pointerId === event.pointerId) cropDrag.current = null;
  };

  const moveCropWithKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!avatarImage || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 32 : 12;
    const next = clampAvatarCrop(avatarImage, {
      zoom: cropZoom,
      x: cropOffset.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0),
      y: cropOffset.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0),
    });
    setCropOffset({ x: next.x, y: next.y });
  };

  const cropStyle = useMemo<CSSProperties | null>(() => {
    if (!avatarImage) return null;
    const scale = Math.max(512 / avatarImage.width, 512 / avatarImage.height) * cropZoom;
    const width = avatarImage.width * scale;
    const height = avatarImage.height * scale;
    return {
      width: `${width / 512 * 100}%`,
      height: `${height / 512 * 100}%`,
      left: `${50 + cropOffset.x / 512 * 100}%`,
      top: `${50 + cropOffset.y / 512 * 100}%`,
    };
  }, [avatarImage, cropZoom, cropOffset]);

  const visible = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return chats.filter((chat) => (filter === "*" || (chat.groupId || "") === filter) &&
      (!q || `${chatDisplayName(chat)} ${chat.name} ${chat.id || ""}`.toLocaleLowerCase().includes(q)));
  }, [chats, filter, query]);
  const visibleSelected = visible.filter((chat) => selected.has(chat.slug)).length;
  const allVisible = visible.length > 0 && visibleSelected === visible.length;
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = visibleSelected > 0 && !allVisible;
  }, [visibleSelected, allVisible]);
  useEffect(() => {
    if (filter !== "*" && filter !== "" && !groups.some((group) => group.id === filter)) setFilter("*");
    if (destination && !groups.some((group) => group.id === destination)) setDestination("");
  }, [groups, filter, destination]);

  const edit = async (action: string, params: Record<string, unknown>, success: string) => {
    if (busy) return false;
    setBusy(action);
    setError("");
    try {
      await call("editChatOrganization", { libraryKey, action, ...params });
      refresh();
      toast(success);
      return true;
    } catch (reason) {
      setError((reason as Error).message);
      refresh();
      return false;
    } finally {
      setBusy("");
    }
  };

  const toggleVisible = () => setSelected((current) => {
    const next = new Set(current);
    visible.forEach((chat) => { if (allVisible) next.delete(chat.slug); else next.add(chat.slug); });
    return next;
  });

  const toggleChat = (slug: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(slug)) next.delete(slug); else next.add(slug);
    return next;
  });

  const dropOn = (event: DragEvent, groupId: string) => {
    event.preventDefault();
    const slugs = dragging.current;
    dragging.current = [];
    setDragTarget(null);
    if (!slugs.length || busy) return;
    void edit("assign", { groupId, slugs }, `已移动 ${slugs.length} 个聊天`).then((ok) => { if (ok) setSelected(new Set()); });
  };

  const dropProps = (groupId: string) => ({
    onDragOver: (event: DragEvent) => { if (dragging.current.length && !busy) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDragTarget(groupId); } },
    onDragLeave: () => setDragTarget(null),
    onDrop: (event: DragEvent) => dropOn(event, groupId),
  });

  const avatarPreview = avatarChat ? {
    avatar: avatarMode === "image" ? avatarData || avatars[avatarChat.slug]?.avatar : avatarMode === "default" ? avatars[avatarChat.slug]?.onlineAvatar : undefined,
    color: avatarMode === "color" && /^#[0-9a-f]{6}$/i.test(avatarColor) ? avatarColor : undefined,
  } : null;

  return createPortal(
    <>
      <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
        <div className="modal chat-organizer" role="dialog" aria-modal="true" aria-labelledby="chat-organizer-title" onKeyDown={(event) => {
          if (event.key === "Escape" && !busy && !deleteGroup && !avatarChat) { event.stopPropagation(); onClose(); }
          if (event.key === "Tab") {
            const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')].filter((element) => element.offsetParent !== null);
            const first = controls[0], last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }
        }}>
          <header className="chat-organizer-head">
            <div><h2 id="chat-organizer-title">整理本地聊天</h2><p>创建分组、批量归类，或设置方便识别的显示名称。</p></div>
            <button className="icon-btn" aria-label="关闭聊天整理" disabled={!!busy} onClick={onClose}><X size={16} /></button>
          </header>
          <div className="chat-organizer-body">
            <aside className="chat-organizer-groups" aria-label="聊天分组">
              <div className="chat-organizer-section-title">分组</div>
              <button className={`chat-organizer-group ${filter === "*" ? "on" : ""}`} onClick={() => setFilter("*")}><Folder size={14} /><span>全部聊天</span><small>{chats.length}</small></button>
              <button className={`chat-organizer-group ${filter === "" ? "on" : ""} ${dragTarget === "" ? "drop-target" : ""}`} {...dropProps("")} onClick={() => setFilter("")}><Folder size={14} /><span>未分组</span><small>{chats.filter((chat) => !chat.groupId).length}</small></button>
              <div className="chat-organizer-group-list">
                {groups.map((group) => renameId === group.id ? (
                  <form key={group.id} className="chat-organizer-rename" onSubmit={(event) => {
                    event.preventDefault();
                    void edit("rename", { groupId: group.id, name: renameName }, "分组名称已更新").then((ok) => { if (ok) setRenameId(""); });
                  }}>
                    <input autoFocus aria-label="分组名称" maxLength={80} value={renameName} onChange={(event) => setRenameName(event.target.value)} />
                    <button className="icon-btn" aria-label="保存分组名称" disabled={!!busy || !renameName.trim()}><Check size={14} /></button>
                    <button type="button" className="icon-btn" aria-label="取消重命名" onClick={() => setRenameId("")}><X size={14} /></button>
                  </form>
                ) : (
                  <div className={`chat-organizer-group-row ${filter === group.id ? "on" : ""} ${dragTarget === group.id ? "drop-target" : ""}`} key={group.id} {...dropProps(group.id)}>
                    <button className="chat-organizer-group" onClick={() => setFilter(group.id)}><Folder size={14} /><span>{group.name}</span><small>{chats.filter((chat) => chat.groupId === group.id).length}</small></button>
                    <button className="icon-btn" aria-label={`重命名分组 ${group.name}`} data-tip="重命名" disabled={!!busy} onClick={() => { setRenameId(group.id); setRenameName(group.name); }}><Pencil size={12} /></button>
                    <button className="icon-btn" aria-label={`删除分组 ${group.name}`} data-tip="删除分组" disabled={!!busy} onClick={() => setDeleteGroup(group)}><Trash2 size={12} /></button>
                  </div>
                ))}
              </div>
              <form className="chat-organizer-create" onSubmit={(event) => {
                event.preventDefault();
                void edit("create", { name: newGroup }, "已创建分组").then((ok) => { if (ok) setNewGroup(""); });
              }}>
                <input value={newGroup} maxLength={80} onChange={(event) => setNewGroup(event.target.value)} placeholder="新分组名称" aria-label="新分组名称" />
                <button className="icon-btn" aria-label="创建分组" disabled={!!busy || !newGroup.trim()}><FolderPlus size={15} /></button>
              </form>
            </aside>
            <section className="chat-organizer-content">
              <label className="chat-organizer-search"><Search size={14} /><input ref={search} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索显示名称、原始名称或 ID" aria-label="搜索本地聊天" /></label>
              <div className="chat-organizer-toolbar">
                <label><input ref={selectAll} type="checkbox" checked={allVisible} onChange={toggleVisible} disabled={!visible.length} /> 全选当前列表</label>
                <span>已选 {selected.size} 个</span>
                <div className="chat-organizer-destination"><Select value={destination} onChange={setDestination} ariaLabel="目标分组" disabled={!!busy} options={[{ value: "", label: "未分组" }, ...groups.map((group) => ({ value: group.id, label: group.name }))]} /></div>
                <button className="btn sm primary" disabled={!!busy || selected.size === 0} onClick={() => void edit("assign", { groupId: destination, slugs: [...selected] }, `已整理 ${selected.size} 个聊天`).then((ok) => { if (ok) setSelected(new Set()); })}>移动</button>
              </div>
              <div className="chat-organizer-list">
                {visible.length === 0 ? <div className="chat-organizer-empty">没有匹配的聊天</div> : visible.map((chat) => (
                  <div className={`chat-organizer-chat ${selected.has(chat.slug) ? "selected" : ""}`} key={chat.slug} role="button" tabIndex={0} aria-pressed={selected.has(chat.slug)}
                    onClick={(event) => { if (aliasSlug !== chat.slug && !(event.target as HTMLElement).closest("button, input, form")) toggleChat(chat.slug); }}
                    onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === " " || event.key === "Enter")) { event.preventDefault(); toggleChat(chat.slug); } }}
                    draggable={!busy && aliasSlug !== chat.slug} onDragStart={(event) => {
                    dragging.current = selected.has(chat.slug) ? [...selected] : [chat.slug];
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", "chat-organization");
                  }} onDragEnd={() => { dragging.current = []; setDragTarget(null); }}>
                    <input type="checkbox" checked={selected.has(chat.slug)} aria-label={`选择 ${chatDisplayName(chat)}`} onChange={() => toggleChat(chat.slug)} />
                    {aliasSlug === chat.slug ? (
                      <form className="chat-organizer-alias" onSubmit={(event) => {
                        event.preventDefault();
                        void edit("alias", { slug: chat.slug, name: aliasName }, "聊天显示名称已更新").then((ok) => { if (ok) setAliasSlug(""); });
                      }}>
                        <input autoFocus maxLength={120} value={aliasName} onChange={(event) => setAliasName(event.target.value)} placeholder={chat.name} aria-label="自定义聊天名称" />
                        <button className="btn sm primary" disabled={!!busy}>保存</button>
                        <button type="button" className="btn sm ghost" onClick={() => setAliasSlug("")}>取消</button>
                      </form>
                    ) : (
                      <>
                        <ChatAvatar name={avatars[chat.slug]?.name || chatDisplayName(chat)} peer={avatars[chat.slug]?.peer || `local:${chat.id || chat.slug}`} avatar={avatars[chat.slug]?.avatar} color={avatars[chat.slug]?.color} fontFamily={avatars[chat.slug]?.fontFamily} fontSize={avatars[chat.slug]?.fontSize} fontColor={avatars[chat.slug]?.fontColor} fontWeight={avatars[chat.slug]?.fontWeight} className="chat-organizer-avatar" />
                        <span className="chat-organizer-chat-name"><b>{chatDisplayName(chat)}</b><small>{chat.displayName ? `原始名称：${chat.name}` : (groups.find((group) => group.id === chat.groupId)?.name || "未分组")}</small></span>
                        <span className="chat-organizer-chat-stats">{chat.mediaReady ? `${chat.media.toLocaleString()} 个媒体 · ${bytes(chat.totalBytes ?? 0)}` : `${chat.media.toLocaleString()} 个媒体 · 大小待核对`}</span>
                        <button className="icon-btn chat-organizer-avatar-button" aria-label={`自定义 ${chatDisplayName(chat)} 的头像`} data-tip="自定义头像" disabled={!!busy} onClick={() => openAvatar(chat)}><ImagePlus size={14} /></button>
                        <button className="icon-btn" aria-label={`设置 ${chatDisplayName(chat)} 的显示名称`} data-tip="设置显示名称" disabled={!!busy} onClick={() => { setAliasSlug(chat.slug); setAliasName(chat.displayName || ""); }}><Pencil size={13} /></button>
                      </>
                    )}
                  </div>
                ))}
              </div>
              {error && <div className="chat-organizer-error" role="alert">{error}</div>}
            </section>
          </div>
          <footer className="chat-organizer-foot"><span>显示名称和自定义头像仅影响本地展示，不会修改 Telegram 聊天。</span><button className="btn ghost" disabled={!!busy} onClick={onClose}>完成</button></footer>
        </div>
      </div>
      <ConfirmDialog open={!!deleteGroup} title="删除这个分组？" message={`“${deleteGroup?.name || ""}”中的聊天会移到未分组，聊天和档案都会保留。`} confirmLabel="删除分组" danger onCancel={() => setDeleteGroup(null)} onConfirm={() => {
        const group = deleteGroup;
        setDeleteGroup(null);
        if (group) void edit("delete", { groupId: group.id }, "分组已删除，聊天已移到未分组");
      }} />
      {avatarChat && createPortal(
        <div className="modal-backdrop avatar-editor-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !avatarBusy && !avatarFileBusy) setAvatarChat(null); }}>
          <div className="modal avatar-editor" ref={avatarDialog} role="dialog" aria-modal="true" aria-labelledby="avatar-editor-title" tabIndex={-1} onKeyDown={(event) => {
            if (event.key === "Escape" && !avatarBusy && !avatarFileBusy) { event.stopPropagation(); setAvatarChat(null); }
            if (event.key === "Tab") {
              const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')].filter((element) => element.offsetParent !== null);
              const first = controls[0], last = controls[controls.length - 1];
              if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus(); }
              else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) { event.preventDefault(); first?.focus(); }
            }
          }}>
            <header className="avatar-editor-head">
              <div><h2 id="avatar-editor-title">自定义聊天头像</h2><p>{chatDisplayName(avatarChat)}</p></div>
              <button type="button" className="icon-btn" aria-label="关闭头像设置" disabled={avatarBusy || avatarFileBusy} onClick={() => setAvatarChat(null)}><X size={16} /></button>
            </header>
            <div className="avatar-editor-body">
              <div className="avatar-editor-preview">
                <ChatAvatar name={chatDisplayName(avatarChat)} peer={avatars[avatarChat.slug]?.peer || `local:${avatarChat.id || avatarChat.slug}`} avatar={avatarPreview?.avatar} color={avatarPreview?.color} fontFamily={hasCustomFont() ? avatarFontFamily : undefined} fontSize={hasCustomFont() ? avatarFontSize : undefined} fontColor={hasCustomFont() ? avatarFontColor : undefined} fontWeight={hasCustomFont() ? avatarFontWeight : undefined} className="avatar-editor-avatar" />
                <div><b>头像预览</b><span>{avatarMode === "default" ? "优先使用已保存的在线头像" : avatarMode === "color" ? "使用颜色渐变与姓名首字" : "使用上传的图片"}</span></div>
              </div>
              <div className="avatar-editor-modes" role="group" aria-label="头像类型">
                {([{ value: "default", label: "默认头像" }, { value: "color", label: "颜色头像" }, { value: "image", label: "上传图片" }] as const).map((mode) => (
                  <button type="button" key={mode.value} className={avatarMode === mode.value ? "on" : ""} aria-pressed={avatarMode === mode.value} disabled={avatarFileBusy} onClick={() => { setAvatarMode(mode.value); setAvatarError(""); }}>{mode.label}</button>
                ))}
              </div>
              {avatarMode === "color" && (
                <section className="avatar-editor-section" aria-label="头像颜色">
                  <div className="avatar-editor-label"><Palette size={14} /><span>渐变预设</span></div>
                  <div className="avatar-color-grid">
                    {AVATAR_COLOR_PRESETS.map((preset) => (
                      <button type="button" key={preset.value} className={`avatar-color-swatch ${avatarColor.toUpperCase() === preset.value ? "on" : ""}`} style={{ background: avatarBackground("", preset.value) }} title={preset.name} aria-label={`使用${preset.name}`} aria-pressed={avatarColor.toUpperCase() === preset.value} onClick={() => setAvatarColor(preset.value)}>
                        {avatarColor.toUpperCase() === preset.value && <Check size={13} />}
                      </button>
                    ))}
                  </div>
                  <label className="avatar-custom-color"><span>自定义颜色</span><span className="avatar-custom-color-preview" style={{ background: avatarBackground("", /^#[0-9a-f]{6}$/i.test(avatarColor) ? avatarColor : "#2F6BFF") }} aria-hidden="true" /><input type="color" value={/^#[0-9a-f]{6}$/i.test(avatarColor) ? avatarColor : "#2F6BFF"} onChange={(event) => setAvatarColor(event.target.value.toUpperCase())} aria-label="选择自定义头像颜色" /><input value={avatarColor} maxLength={7} spellCheck={false} aria-label="头像颜色值" onChange={(event) => setAvatarColor(event.target.value.toUpperCase())} /></label>
                </section>
              )}
              {avatarMode !== "image" && (
                <section className="avatar-font-section" aria-label="头像文字样式">
                  <div className="avatar-editor-label"><Type size={14} /><span>文字样式</span><button type="button" className="avatar-font-reset" onClick={resetAvatarFont}>重置</button></div>
                  <div className="avatar-font-grid">
                    <label className="avatar-font-field"><span>字体</span><select value={avatarFontFamily} onChange={(event) => setAvatarFontFamily(event.target.value)}>{AVATAR_FONT_OPTIONS.map((font) => <option key={font.value} value={font.value}>{font.label}</option>)}</select></label>
                    <label className="avatar-font-field"><span>字重</span><select value={avatarFontWeight} onChange={(event) => setAvatarFontWeight(Number(event.target.value))}>{[{ value: 400, label: "常规 400" }, { value: 500, label: "中等 500" }, { value: 600, label: "半粗 600" }, { value: 650, label: "半粗 650" }, { value: 700, label: "粗体 700" }, { value: 800, label: "特粗 800" }, { value: 900, label: "黑体 900" }].map((weight) => <option key={weight.value} value={weight.value}>{weight.label}</option>)}</select></label>
                    <label className="avatar-font-field avatar-font-size"><span>字号 <output>{avatarFontSize}</output></span><input type="range" min={14} max={34} step={1} value={avatarFontSize} aria-label="头像相对字号" onChange={(event) => setAvatarFontSize(Number(event.target.value))} /></label>
                    <label className="avatar-font-field avatar-font-ink"><span>字体颜色</span><span className="avatar-font-ink-controls"><input type="color" value={/^#[0-9a-f]{6}$/i.test(avatarFontColor) ? avatarFontColor : "#FFFFFF"} onChange={(event) => setAvatarFontColor(event.target.value.toUpperCase())} aria-label="选择头像字体颜色" /><input value={avatarFontColor} maxLength={7} spellCheck={false} aria-label="头像字体颜色值" onChange={(event) => setAvatarFontColor(event.target.value.toUpperCase())} /></span></label>
                  </div>
                  <small className="avatar-font-hint">字号会随头像尺寸等比缩放，侧栏和整理列表使用同一比例。</small>
                </section>
              )}
              {avatarMode === "image" && (
                <section className="avatar-editor-section" aria-label="上传头像图片">
                  <input ref={avatarFileInput} className="avatar-file-input" type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" onChange={(event) => void selectAvatarFile(event)} />
                  <button type="button" className="avatar-upload" disabled={avatarFileBusy} onClick={() => avatarFileInput.current?.click()}>
                    <span className="avatar-upload-icon"><Upload size={20} /></span>
                    <span><b>{avatarFileBusy ? "正在处理图片…" : avatarName || (avatarChat.avatarFile ? "替换当前头像" : "选择 PNG 或 JPG 图片")}</b><small>{avatarFileBusy ? "请稍候" : avatarName ? "可拖动和缩放裁切，保存时输出 512 × 512" : "最大 10 MB，支持自行拖动和缩放裁切"}</small></span>
                  </button>
                  {avatarImage && cropStyle && (
                    <div className="avatar-crop-editor">
                      <div ref={cropStage} className="avatar-crop-stage" role="img" aria-label="头像裁切区域，拖动或使用方向键调整位置" tabIndex={0} onKeyDown={moveCropWithKey} onPointerDown={startCropDrag} onPointerMove={moveCropDrag} onPointerUp={endCropDrag} onPointerCancel={endCropDrag}>
                        <img src={avatarImage.source} alt="" draggable={false} style={cropStyle} />
                      </div>
                      <div className="avatar-crop-controls">
                        <label className="avatar-crop-zoom"><span>缩放 <output>{Math.round(cropZoom * 100)}%</output></span><input type="range" min={1} max={3} step={0.01} value={cropZoom} aria-label="头像裁切缩放" onChange={(event) => updateCropZoom(Number(event.target.value))} /></label>
                        <button type="button" className="btn sm ghost" onClick={resetCrop}><RotateCcw size={12} />重置裁切</button>
                      </div>
                      <p className="avatar-crop-hint">拖动图片调整位置，使用滑杆缩放；虚线框内为最终头像。</p>
                    </div>
                  )}
                </section>
              )}
              {avatarMode === "default" && <div className="avatar-default-note">未设置自定义头像时，将使用匹配到的在线聊天头像；没有在线头像时显示彩色渐变。</div>}
              {avatarError && <div className="avatar-editor-error" role="alert">{avatarError}</div>}
            </div>
            <footer className="avatar-editor-foot">
              <button type="button" className="btn ghost" disabled={avatarBusy || avatarFileBusy} onClick={() => { setAvatarMode("default"); resetAvatarFont(); setAvatarError(""); }}><RotateCcw size={13} />恢复默认</button>
              <span className="spacer" />
              <button type="button" className="btn ghost" disabled={avatarBusy || avatarFileBusy} onClick={() => setAvatarChat(null)}>取消</button>
              <button type="button" className="btn primary" disabled={avatarBusy || avatarFileBusy || avatarMode === "image" && !avatarImage && !avatarChat.avatarFile} onClick={() => void saveAvatar()}>{avatarBusy ? "保存中…" : "保存头像"}</button>
            </footer>
          </div>
        </div>, document.body,
      )}
    </>, document.body,
  );
}
