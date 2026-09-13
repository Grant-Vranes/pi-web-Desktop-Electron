"use client";

// 占位实现(Task 5 替换):避免中间提交出现指向不存在模块的 dynamic import。
// Props 形状与 FileViewer 的调用点保持一致,保证中间提交可编译。
interface DrawioViewerProps {
  filePath: string;
  cwd?: string;
  sourceSessionId?: string | null;
  watchEnabled?: boolean;
  onFallbackToText: () => void;
}

export default function DrawioViewer(_props: DrawioViewerProps) {
  return null;
}
