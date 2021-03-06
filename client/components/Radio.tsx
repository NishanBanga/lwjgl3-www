import { unstable_useOpaqueIdentifier as useOpaqueIdentifier } from 'react';

interface Props {
  value: any;
  label: string;
  disabled?: boolean;
  checked?: boolean;
  onChange: (value: any) => void;
}

export const Radio = ({ label, value, checked = false, onChange, disabled = false }: Props) => {
  const htmlForId = useOpaqueIdentifier();

  return (
    <div className="form-check">
      <input
        type="radio"
        id={htmlForId}
        className="form-check-input"
        disabled={disabled}
        checked={checked}
        onChange={() => {
          onChange(value);
        }}
      />
      <label className="form-check-label" htmlFor={htmlForId}>
        {label}
      </label>
    </div>
  );
};
