import { useCallback, useState, useSyncExternalStore } from 'react';
import { Users, Check } from 'lucide-react';
import {
  PRESENCE_COLORS,
  type NoteSession,
  type PresenceUser,
} from '@typo/client';
export function PresencePanel({
  session,
  user,
  onUserChange,
}: {
  session: NoteSession;
  user: PresenceUser;
  onUserChange: (user: PresenceUser) => void;
}) {
  const members = useSyncExternalStore(
    useCallback((listener) => session.subscribePresence(listener), [session]),
    () => session.members,
  );
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(user.name);
  function rename() {
    const trimmed = name.trim().slice(0, 48);
    if (trimmed) {
      setName(trimmed);
      onUserChange({ ...user, name: trimmed });
    } else setName(user.name);
  }
  return (
    <div className="presence-panel">
      <button
        className="presence-trigger"
        aria-label={`在线成员 ${members.length} 人`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="member-avatars">
          {members.slice(0, 3).map((member) => (
            <span
              key={member.id}
              style={{ background: member.user.color }}
              title={member.user.name}
            >
              {member.user.name.slice(0, 1)}
            </span>
          ))}
        </span>
        <Users size={14} />
        <span>{members.length} 在线</span>
      </button>
      {open && (
        <>
          <button
            className="presence-dismiss"
            aria-label="关闭在线成员"
            onClick={() => setOpen(false)}
          />
          <section className="presence-popover" aria-label="在线成员列表">
            <strong>正在此文档中 · {members.length}</strong>
            <p>成员光标按颜色显示</p>
            <ul>
              {members.map((member) => (
                <li key={member.id}>
                  <span
                    className="member-dot"
                    style={{ background: member.user.color }}
                  />
                  <span>
                    {member.user.name}
                    {member.id === session.connectionId ? '（你）' : ''}
                  </span>
                  <small>
                    {member.user.client === 'vscode'
                      ? 'VS Code'
                      : member.user.client === 'web'
                        ? 'Web'
                        : '其他端'}
                  </small>
                </li>
              ))}
            </ul>
            <label>
              我的显示名称
              <input
                aria-label="我的显示名称"
                value={name}
                maxLength={48}
                onChange={(e) => setName(e.target.value)}
                onBlur={rename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
              />
            </label>
            <div className="profile-colors">
              {PRESENCE_COLORS.map((color) => (
                <button
                  key={color}
                  aria-label={`光标颜色 ${color}`}
                  aria-pressed={user.color === color}
                  style={{ background: color }}
                  onClick={() => onUserChange({ ...user, color })}
                >
                  {user.color === color ? <Check size={13} /> : null}
                </button>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
