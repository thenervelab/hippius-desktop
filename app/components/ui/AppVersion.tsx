"use client";

import { useState, useEffect } from "react";
import { getVersion } from "@tauri-apps/api/app";

export default function AppVersion() {
  const [version, setVersion] = useState<string>("");

  useEffect(() => {
    getVersion().then((v) => setVersion(v));
  }, []);

  return <span>{version}</span>;
}
