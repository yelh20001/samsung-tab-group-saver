using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace SamsungGracefulClose
{
    internal static class Program
    {
        private const uint SHUTDOWN_PRIORITY_HIGH = 0x3FF;

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetProcessShutdownParameters(uint dwLevel, uint dwFlags);

        [STAThread]
        private static void Main()
        {
            bool createdNew;
            using (var mutex = new Mutex(true, "Local\\SamsungGracefulClose_Guard_Mutex", out createdNew))
            {
                if (!createdNew) return;
                SetProcessShutdownParameters(SHUTDOWN_PRIORITY_HIGH, 0);
                Application.EnableVisualStyles();
                using (var window = new ShutdownGuardWindow())
                {
                    Application.Run();
                }
            }
        }
    }

    internal sealed class ShutdownGuardWindow : NativeWindow, IDisposable
    {
        private const int WM_QUERYENDSESSION = 0x0011;
        private const int WM_ENDSESSION = 0x0016;
        private const uint WM_CLOSE = 0x0010;
        private const string ProcessName = "samsunginternet";

        private bool _handlingShutdown;

        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool ShutdownBlockReasonCreate(IntPtr hWnd, string pwszReason);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool ShutdownBlockReasonDestroy(IntPtr hWnd);

        public ShutdownGuardWindow()
        {
            var cp = new CreateParams
            {
                Caption = "SamsungGracefulCloseGuard",
                Style = 0,
                ExStyle = 0,
                Parent = IntPtr.Zero
            };
            CreateHandle(cp);
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_QUERYENDSESSION)
            {
                if (!_handlingShutdown)
                {
                    _handlingShutdown = true;
                    CloseSamsungBrowserGracefully();
                }
                m.Result = (IntPtr)1;
                return;
            }
            if (m.Msg == WM_ENDSESSION)
            {
                if (m.WParam != IntPtr.Zero)
                {
                    Application.ExitThread();
                }
                else
                {
                    _handlingShutdown = false;
                }
                m.Result = IntPtr.Zero;
                return;
            }
            base.WndProc(ref m);
        }

        private void CloseSamsungBrowserGracefully()
        {
            var pids = GetSamsungPids();
            if (pids.Count == 0) return;

            ShutdownBlockReasonCreate(Handle, "正在安全关闭三星浏览器以保存播放器和标签页数据...");
            try
            {
                SendCloseToBrowserWindows(pids);
                var sw = Stopwatch.StartNew();
                bool resent = false;
                while (sw.ElapsedMilliseconds < 6000)
                {
                    Thread.Sleep(100);
                    pids = GetSamsungPids();
                    if (pids.Count == 0) break;
                    if (!resent && sw.ElapsedMilliseconds >= 1500)
                    {
                        resent = true;
                        SendCloseToBrowserWindows(pids);
                    }
                }
            }
            finally
            {
                ShutdownBlockReasonDestroy(Handle);
            }
        }

        private static HashSet<uint> GetSamsungPids()
        {
            var pids = new HashSet<uint>();
            var procs = Process.GetProcessesByName(ProcessName);
            foreach (var proc in procs)
            {
                try { pids.Add((uint)proc.Id); }
                catch { }
                finally { proc.Dispose(); }
            }
            return pids;
        }

        private static void SendCloseToBrowserWindows(HashSet<uint> pids)
        {
            EnumWindows((hWnd, lParam) =>
            {
                if (!IsWindowVisible(hWnd)) return true;
                uint pid;
                GetWindowThreadProcessId(hWnd, out pid);
                if (pids.Contains(pid))
                {
                    PostMessage(hWnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
                }
                return true;
            }, IntPtr.Zero);
        }

        public void Dispose()
        {
            if (Handle != IntPtr.Zero)
            {
                DestroyHandle();
            }
        }
    }
}
