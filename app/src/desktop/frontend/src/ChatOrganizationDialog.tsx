import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { Check, Folder, FolderPlus, ImagePlus, Palette, Pencil, RotateCcw, Search, Trash2, Upload, X } from "lucide-react";
import { ConfirmDialog } from "./ConfirmDialog";
import { Select } from "./Select";
import { call } from "./rpc";
import { bytes } from "./format";
import { chatDisplayName } from "./chatDisplay";
import { AVATAR_COLOR_PRESETS, ChatAvatar, type LocalChatAvatar } from "./ChatAvatar";
import type { ChatGroup, ChatRow } from "./types";
import "./ChatOrganizationDialog.css";

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

async function prepareAvatarFile(file: File) {
  if (!/\.(png|jpe?g)$/i.test(file.name) && file.type !== "image/png" && file.type !== "image/jpeg") throw new Error("请选择 PNG 或 JPG 图片");
  if (file.size > 10 * 1024 * 1024) throw new Error("图片不能超过 10 MB");
  const buffer = await file.arrayBuffer();
  const { width, height } = readAvatarDimensions(buffer);
  if (width <= 0 || height <= 0 || width > 8192 || height > 8192 || width * height > 12_000_000) throw new Error("图片尺寸过大，请选择更小的图片");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const size = 512;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前环境无法处理图片");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, size, size);
    const scale = Math.max(size / image.naturalWidth, size / image.naturalHeight);
    const sourceSize = size / scale;
    const sourceX = (image.naturalWidth - sourceSize) / 2;
    const sourceY = (image.naturalHeight - sourceSize) / 2;
    context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, size, size);
    return canvas.toDataURL("image/jpeg", 0.9);
  } catch {
    throw new Error("图片无法解析，请换一张 PNG 或 JPG 图片");
  } finally {
    URL.revokeObjectURL(url);
  }
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
  const [avatarData, setAvatarData] = useState("");
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

  const openAvatar = (chat: ChatRow) => {
    avatarSelection.current++;
    setAvatarFileBusy(false);
    setAvatarChat(chat);
    setAvatarMode(chat.avatarFile ? "image" : chat.avatarColor ? "color" : "default");
    setAvatarColor(chat.avatarColor || AVATAR_COLOR_PRESETS[0].value);
    setAvatarData("");
    setAvatarName("");
    setAvatarError("");
  };

  const saveAvatar = async () => {
    if (!avatarChat || avatarBusy || avatarFileBusy || avatarMode === "image" && !avatarData && !avatarChat.avatarFile) return;
    if (avatarMode === "image" && !avatarData && avatarChat.avatarFile) {
      setAvatarChat(null);
      return;
    }
    setAvatarBusy(true);
    setAvatarError("");
    try {
      await call("editChatOrganization", {
        libraryKey,
        action: "avatar",
        slug: avatarChat.slug,
        avatarColor: avatarMode === "color" ? avatarColor : "",
        avatarData: avatarMode === "image" ? avatarData : "",
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
    setAvatarName("");
    try {
      const data = await prepareAvatarFile(file);
      if (selection !== avatarSelection.current) return;
      setAvatarData(data);
      setAvatarName(file.name);
      setAvatarMode("image");
    } catch (reason) {
      if (selection === avatarSelection.current) setAvatarError((reason as Error).message);
    } finally {
      if (selection === avatarSelection.current) setAvatarFileBusy(false);
    }
  };

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
                        <ChatAvatar name={avatars[chat.slug]?.name || chatDisplayName(chat)} peer={avatars[chat.slug]?.peer || `local:${chat.id || chat.slug}`} avatar={avatars[chat.slug]?.avatar} color={avatars[chat.slug]?.color} className="chat-organizer-avatar" />
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
              if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
              else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }
          }}>
            <header className="avatar-editor-head">
              <div><h2 id="avatar-editor-title">自定义聊天头像</h2><p>{chatDisplayName(avatarChat)}</p></div>
              <button type="button" className="icon-btn" aria-label="关闭头像设置" disabled={avatarBusy || avatarFileBusy} onClick={() => setAvatarChat(null)}><X size={16} /></button>
            </header>
            <div className="avatar-editor-body">
              <div className="avatar-editor-preview">
                <ChatAvatar name={chatDisplayName(avatarChat)} peer={avatars[avatarChat.slug]?.peer || `local:${avatarChat.id || avatarChat.slug}`} avatar={avatarPreview?.avatar} color={avatarPreview?.color} className="avatar-editor-avatar" />
                <div><b>头像预览</b><span>{avatarMode === "default" ? "优先使用已保存的在线头像" : avatarMode === "color" ? "使用颜色渐变与姓名首字" : "使用上传的图片"}</span></div>
              </div>
              <div className="avatar-editor-modes" role="group" aria-label="头像类型">
                {([{ value: "default", label: "默认头像" }, { value: "color", label: "颜色头像" }, { value: "image", label: "上传图片" }] as const).map((mode) => (
                  <button type="button" key={mode.value} className={avatarMode === mode.value ? "on" : ""} aria-pressed={avatarMode === mode.value} disabled={avatarFileBusy} onClick={() => { setAvatarMode(mode.value); setAvatarError(""); }}>{mode.label}</button>
                ))}
              </div>
              {avatarMode === "color" && (
                <section className="avatar-editor-section" aria-label="头像颜色">
                  <div className="avatar-editor-label"><Palette size={14} /><span>预设颜色</span></div>
                  <div className="avatar-color-grid">
                    {AVATAR_COLOR_PRESETS.map((preset) => (
                      <button type="button" key={preset.value} className={`avatar-color-swatch ${avatarColor.toUpperCase() === preset.value ? "on" : ""}`} style={{ background: preset.value }} title={preset.name} aria-label={`使用${preset.name}`} aria-pressed={avatarColor.toUpperCase() === preset.value} onClick={() => setAvatarColor(preset.value)}>
                        {avatarColor.toUpperCase() === preset.value && <Check size={13} />}
                      </button>
                    ))}
                  </div>
                  <label className="avatar-custom-color"><span>自定义颜色</span><input type="color" value={/^#[0-9a-f]{6}$/i.test(avatarColor) ? avatarColor : "#2F6BFF"} onChange={(event) => setAvatarColor(event.target.value.toUpperCase())} aria-label="选择自定义头像颜色" /><input value={avatarColor} maxLength={7} spellCheck={false} aria-label="头像颜色值" onChange={(event) => setAvatarColor(event.target.value.toUpperCase())} /></label>
                </section>
              )}
              {avatarMode === "image" && (
                <section className="avatar-editor-section" aria-label="上传头像图片">
                  <input ref={avatarFileInput} className="avatar-file-input" type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" onChange={(event) => void selectAvatarFile(event)} />
                  <button type="button" className="avatar-upload" disabled={avatarFileBusy} onClick={() => avatarFileInput.current?.click()}>
                    <span className="avatar-upload-icon"><Upload size={20} /></span>
                    <span><b>{avatarFileBusy ? "正在处理图片…" : avatarName || (avatarChat.avatarFile ? "替换当前头像" : "选择 PNG 或 JPG 图片")}</b><small>{avatarFileBusy ? "请稍候" : avatarName ? "已处理为 512 × 512，保存后生效" : "最大 10 MB，自动居中裁切并压缩"}</small></span>
                  </button>
                </section>
              )}
              {avatarMode === "default" && <div className="avatar-default-note">未设置自定义头像时，将使用匹配到的在线聊天头像；没有在线头像时显示彩色渐变。</div>}
              {avatarError && <div className="avatar-editor-error" role="alert">{avatarError}</div>}
            </div>
            <footer className="avatar-editor-foot">
              <button type="button" className="btn ghost" disabled={avatarBusy || avatarFileBusy} onClick={() => { setAvatarMode("default"); setAvatarError(""); }}><RotateCcw size={13} />恢复默认</button>
              <span className="spacer" />
              <button type="button" className="btn ghost" disabled={avatarBusy || avatarFileBusy} onClick={() => setAvatarChat(null)}>取消</button>
              <button type="button" className="btn primary" disabled={avatarBusy || avatarFileBusy || avatarMode === "image" && !avatarData && !avatarChat.avatarFile} onClick={() => void saveAvatar()}>{avatarBusy ? "保存中…" : "保存头像"}</button>
            </footer>
          </div>
        </div>, document.body,
      )}
    </>, document.body,
  );
}
