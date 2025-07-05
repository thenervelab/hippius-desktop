"use client";

import Login from "../components/auth/Login";
import { Graphsheet } from "../components/ui";

export default function LoginPage() {
  return (
    <div className="flex grow flex-col items-center w-full justify-center relative overflow-hidden h-full">
      <div className="absolute w-full top-0 h-full opacity-5">
        <Graphsheet
          majorCell={{
            lineColor: [31, 80, 189, 1.0],
            lineWidth: 2,
            cellDim: 150,
          }}
          minorCell={{
            lineColor: [49, 103, 211, 1.0],
            lineWidth: 1,
            cellDim: 15,
          }}
          className="absolute w-full left-0 h-full duration-500"
        />
      </div>
      <Login />
    </div>
  );
}
