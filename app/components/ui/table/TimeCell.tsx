import { formatTimeDiff } from "@/app/lib/utils"
import React, { useState, useEffect } from "react"



export const TimeCell: React.FC<{ ts: number | string }> = ({ ts }) => {
    const [label, setLabel] = useState(() => formatTimeDiff(ts))

    useEffect(() => {
        const id = setInterval(() => {
            setLabel(formatTimeDiff(ts))
        }, 1000)
        return () => clearInterval(id)
    }, [ts])

    return (
        <div className="relative flex items-center min-w-[100px]">
            <span className="absolute left-0 text-grey-60">{label}</span>
        </div>
    )
}
