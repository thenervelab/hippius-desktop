import React, { useRef } from 'react';
import * as Checkbox from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { preserveClosestScrollPosition } from "./preserveClosestScrollPosition";

interface FileCheckboxProps {
    selected: boolean;
    onChange: () => void;
    disabled?: boolean;
}

const FileCheckbox: React.FC<FileCheckboxProps> = ({
    selected,
    onChange,
    disabled = false
}) => {
    const checkboxRef = useRef<HTMLButtonElement | null>(null);

    return (
        <Checkbox.Root
            ref={checkboxRef}
            className="h-4 w-4 rounded border border-grey-70 flex items-center justify-center bg-grey-90 data-[state=checked]:bg-primary-50 data-[state=checked]:border-primary-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            checked={selected}
            onCheckedChange={() => {
                preserveClosestScrollPosition(checkboxRef.current, onChange);
            }}
            disabled={disabled}
        >
            <Checkbox.Indicator>
                <Check className="h-3.5 w-3.5 text-white" />
            </Checkbox.Indicator>
        </Checkbox.Root>
    );
};

export default FileCheckbox;
