import { Button } from '@base-ui/react/button';
import { Menu } from '@base-ui/react/menu';
import type { ReactNode } from 'react';
import styles from './controls.module.css';

export function DropdownMenu({
  label,
  trigger,
  triggerClassName,
  disabled,
  children,
}: {
  label: string;
  trigger: ReactNode;
  triggerClassName?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        className={triggerClassName}
        aria-label={label}
        disabled={disabled}
        render={<Button />}
      >
        {trigger}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          className={styles['overlay-positioner']}
          align="end"
          sideOffset={4}
        >
          <Menu.Popup className={styles['overlay-popup']}>
            {children}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function DropdownMenuItem({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Menu.Item className={styles['overlay-item']} onClick={onClick}>
      {children}
    </Menu.Item>
  );
}
