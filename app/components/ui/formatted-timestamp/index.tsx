import React from 'react';
import { parseDateAndTime } from '@/app/lib/utils/dateUtils';

interface FormattedTimestampProps {
    timestamp: number;
    className?: string;
}

const FormattedTimestamp: React.FC<FormattedTimestampProps> = ({
    timestamp,
    className
}) => {
    if (!timestamp) {
        return <span className="text-grey-50">—</span>;
    }

    const isRecentTimestamp = (timestamp > 946684800 && timestamp < 4102444800); // Between 2000-01-01 and 2100-01-01

    // Convert timestamp to milliseconds for JavaScript Date
    // Unix timestamps are in seconds, JavaScript needs milliseconds
    const date = new Date(isRecentTimestamp ? timestamp * 1000 : timestamp);

    // If the date is invalid or extremely old/future, show placeholder
    if (isNaN(date.getTime()) || date.getFullYear() < 2000 || date.getFullYear() > 2100) {
        return <span className="text-grey-50">—</span>;
    }

    const { date: formattedDate, time: formattedTime } = parseDateAndTime(date.toISOString());

    return (
        <div className={`text-left text-base font-medium text-grey-60 self-start ${className || ''}`}>
            <div>{formattedDate}{" "}{formattedTime}</div>
        </div>
    );
};

export default FormattedTimestamp;
