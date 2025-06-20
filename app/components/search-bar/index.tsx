"use client";

import { Search } from "lucide-react";

const SearchBar: React.FC = () => {
  return (
    <div className="relative mb-6 w-full max-w-md">
      <div className="absolute inset-y-0 left-0 flex items-center pl-3">
        <Search className="h-4 w-4 text-gray-400" />
      </div>
      <input
        type="text"
        placeholder="Search for anything"
        className="pl-10 pr-4 py-2 w-full bg-white border border-gray-200 rounded-lg text-sm"
      />
    </div>
  );
};

export default SearchBar;
