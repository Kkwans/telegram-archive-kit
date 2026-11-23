import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { Check, Folder, FolderPlus, Pencil, Search, Trash2, X } from "lucide-react";
import { ConfirmDialog } from "./ConfirmDialog";
import { Select } from "./Select";
import { call } from "./rpc";
import { bytes } from "./format";
import { chatDisplayName } from "./chatDisplay";
import { ChatAvatar, type LocalChatAvatar } from "./ChatAvatar";
import type { ChatGroup, ChatRow } from "./types";
import "./ChatOrganizationDialog.css";

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
  const [deleteGroup, setDeleteGroup] = useState<ChatGroup | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [dragTarget, setDragTarget] = useState<string | null>(null);
  const dragging = useRef<string[]>([]);
  const search = useRef<HTMLInputElement>(null);
  const selectAll = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const previous = document.activeElement;
    search.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);

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

  return createPortal(
    <>
      <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
        <div className="modal chat-organizer" role="dialog" aria-modal="true" aria-labelledby="chat-organizer-title" onKeyDown={(event) => {
          if (event.key === "Escape" && !busy && !deleteGroup) { event.stopPropagation(); onClose(); }
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
                        <ChatAvatar name={avatars[chat.slug]?.name || chatDisplayName(chat)} peer={avatars[chat.slug]?.peer || `local:${chat.id || chat.slug}`} avatar={avatars[chat.slug]?.avatar} className="chat-organizer-avatar" />
                        <span className="chat-organizer-chat-name"><b>{chatDisplayName(chat)}</b><small>{chat.displayName ? `原始名称：${chat.name}` : (groups.find((group) => group.id === chat.groupId)?.name || "未分组")}</small></span>
                        <span className="chat-organizer-chat-stats">{chat.mediaReady ? `${chat.media.toLocaleString()} 个媒体 · ${bytes(chat.totalBytes ?? 0)}` : `${chat.media.toLocaleString()} 个媒体 · 大小待核对`}</span>
                        <button className="icon-btn" aria-label={`设置 ${chatDisplayName(chat)} 的显示名称`} data-tip="设置显示名称" disabled={!!busy} onClick={() => { setAliasSlug(chat.slug); setAliasName(chat.displayName || ""); }}><Pencil size={13} /></button>
                      </>
                    )}
                  </div>
                ))}
              </div>
              {error && <div className="chat-organizer-error" role="alert">{error}</div>}
            </section>
          </div>
          <footer className="chat-organizer-foot"><span>显示名称不会修改 Telegram 聊天或在线关联。留空后恢复原名。</span><button className="btn ghost" disabled={!!busy} onClick={onClose}>完成</button></footer>
        </div>
      </div>
      <ConfirmDialog open={!!deleteGroup} title="删除这个分组？" message={`“${deleteGroup?.name || ""}”中的聊天会移到未分组，聊天和档案都会保留。`} confirmLabel="删除分组" danger onCancel={() => setDeleteGroup(null)} onConfirm={() => {
        const group = deleteGroup;
        setDeleteGroup(null);
        if (group) void edit("delete", { groupId: group.id }, "分组已删除，聊天已移到未分组");
      }} />
    </>, document.body,
  );
}
