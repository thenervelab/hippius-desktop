import React, { useState, useEffect } from "react";
import { InView } from "react-intersection-observer";
import { invoke } from "@tauri-apps/api/core";
import { cn } from "@/lib/utils";
import ListEncryptionKey from "./ListEncryptionKey";
import GenerateNewKey from "./GenerateNewKey";
import ImportEncryptionKey from "./ImportEncryptionKey";

const EncryptionKey = () => {
  const [encryptionKeys, setEncryptionKeys] = useState<
    Array<{ id: number; key: string }>
  >([]);
  const [showGenerateKey, setShowGenerateKey] = useState(false);
  const [showImportKey, setShowImportKey] = useState(false);
  const [generatedKey, setGeneratedKey] = useState("");
  const [importedKey, setImportedKey] = useState("");

  useEffect(() => {
    fetchEncryptionKeys();
  }, []);

  const fetchEncryptionKeys = async () => {
    try {
      const keys = await invoke<Array<{ id: number; key: string }>>(
        "get_encryption_keys"
      );
      setEncryptionKeys(keys);
      return keys;
    } catch (error) {
      console.log("Failed to fetch encryption keys:", error);
    }
  };

  const handleGenerateClick = () => {
    setShowGenerateKey(true);
    setShowImportKey(false);
  };

  const handleImportClick = () => {
    setShowImportKey(true);
    setShowGenerateKey(false);
  };

  const handleBackClick = () => {
    setShowGenerateKey(false);
    setShowImportKey(false);
  };

  const handleKeyGenerated = async () => {
    const keys = await fetchEncryptionKeys();
    if (keys && keys.length > 0) {
      setGeneratedKey(keys[0].key);
    }
  };

  const handleKeyImported = async () => {
    const keys = await fetchEncryptionKeys();
    if (keys && keys.length > 0) {
      setImportedKey(keys[0].key);
    }
  };

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div
          ref={ref}
          className="w-full border broder-grey-80 rounded-lg  overflow-hidden relative bg-[url('/assets/balance-bg-layer.png')] bg-repeat-round bg-cover"
        >
          <div className="relative w-full">
            {/* List View */}
            <div
              className={cn(
                "w-full p-4 transition-all duration-500 ease-in-out",
                showGenerateKey || showImportKey
                  ? "absolute top-0 left-0 opacity-0 pointer-events-none transform -translate-x-full"
                  : "relative opacity-100 pointer-events-auto transform translate-x-0"
              )}
            >
              <ListEncryptionKey
                encryptionKeys={encryptionKeys}
                inView={inView && !showGenerateKey && !showImportKey}
                onGenerateClick={handleGenerateClick}
                onImportClick={handleImportClick}
              />
            </div>

            {/* Generate View */}
            <div
              className={cn(
                "w-full p-4 transition-all duration-500 ease-in-out",
                showGenerateKey
                  ? "relative opacity-100 pointer-events-auto transform translate-x-0"
                  : "absolute top-0 left-0 opacity-0 pointer-events-none transform translate-x-full"
              )}
            >
              <GenerateNewKey
                generatedKey={generatedKey}
                inView={inView && showGenerateKey}
                onBack={handleBackClick}
                onKeyGenerated={handleKeyGenerated}
              />
            </div>

            {/* Import View */}
            <div
              className={cn(
                "w-full p-4 transition-all duration-500 ease-in-out",
                showImportKey
                  ? "relative opacity-100 pointer-events-auto transform translate-x-0"
                  : "absolute top-0 left-0 opacity-0 pointer-events-none transform translate-x-full"
              )}
            >
              <ImportEncryptionKey
                importedKey={importedKey}
                inView={inView && showImportKey}
                onBack={handleBackClick}
                onKeyImported={handleKeyImported}
              />
            </div>
          </div>
        </div>
      )}
    </InView>
  );
};

export default EncryptionKey;
