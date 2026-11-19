import { Dialog } from '@base-ui/react/dialog';
import type { ReactNode } from 'react';
import styles from './controls.module.css';

export const ModalClose = Dialog.Close;

export function Modal({
  title,
  description,
  onClose,
  children,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={styles.backdrop} />
        <Dialog.Popup className={styles['dialog-popup']}>
          <Dialog.Title>{title}</Dialog.Title>
          {description && (
            <Dialog.Description>{description}</Dialog.Description>
          )}
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ModalActions({ children }: { children: ReactNode }) {
  return <div className={styles['dialog-actions']}>{children}</div>;
}
