import { Select } from '@base-ui/react/select';
import { ChevronDown } from 'lucide-react';
import styles from './controls.module.css';

export type SelectOption = { value: string; label: string };

export function SelectField({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string | null) => void;
  disabled?: boolean;
}) {
  return (
    <Select.Root
      items={options}
      value={value}
      disabled={disabled}
      onValueChange={(next) => onChange(next)}
    >
      <Select.Trigger aria-label={label} className={styles['select-trigger']}>
        <Select.Value />
        <Select.Icon>
          <ChevronDown size={13} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner
          className={styles['overlay-positioner']}
          sideOffset={5}
          alignItemWithTrigger={false}
        >
          <Select.Popup className={styles['overlay-popup']}>
            <Select.List>
              {options.map((item) => (
                <Select.Item
                  key={item.value}
                  value={item.value}
                  className={styles['overlay-item']}
                >
                  <Select.ItemText>{item.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
