import { Button } from '@base-ui/react/button';
import { Input } from '@base-ui/react/input';
import { Popover } from '@base-ui/react/popover';
import styles from './PresencePanel.module.css';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { Users, Check, X } from 'lucide-react';
import {
  PRESENCE_COLORS,
  type NoteSession,
  type PresenceUser,
} from '@formd/client';
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
  const [name, setName] = useState(user.name);
  function rename() {
    const trimmed = name.trim().slice(0, 48);
    if (trimmed) {
      setName(trimmed);
      onUserChange({ ...user, name: trimmed });
    } else setName(user.name);
  }
  return (
    <Popover.Root>
      <Popover.Trigger
        className={styles['presence-trigger']}
        aria-label={`在线成员 ${members.length} 人`}
      >
        <span className={styles['member-avatars']}>
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
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          className={styles.positioner}
          align="end"
          sideOffset={8}
        >
          <Popover.Popup
            className={styles['presence-popover']}
            aria-label="在线成员"
          >
            <section aria-label="在线成员列表">
              <div className={styles.heading}>
                <strong>在线成员 · {members.length}</strong>
                <Popover.Close aria-label="关闭在线成员">
                  <X size={15} />
                </Popover.Close>
              </div>
              <ul>
                {members.map((member) => (
                  <li key={member.id}>
                    <span
                      className={styles['member-dot']}
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
                          : member.user.client === 'agent'
                            ? 'Agent'
                            : '其他端'}
                    </small>
                  </li>
                ))}
              </ul>
              <label>
                我的显示名称
                <Input
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
              <div className={styles['profile-colors']}>
                {PRESENCE_COLORS.map((color) => (
                  <Button
                    key={color}
                    aria-label={`光标颜色 ${color}`}
                    aria-pressed={user.color === color}
                    style={{ background: color }}
                    onClick={() => onUserChange({ ...user, color })}
                  >
                    {user.color === color ? <Check size={13} /> : null}
                  </Button>
                ))}
              </div>
            </section>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
