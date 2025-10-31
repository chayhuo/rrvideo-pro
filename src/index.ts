import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import puppeteer from "puppeteer";
// import type { eventWithTime } from "rrweb/typings/types";
import type { RRwebPlayerOptions } from "rrweb-player";
import type { Page, Browser } from "puppeteer";

const rrwebScriptPath = path.resolve(
  require.resolve("rrweb-player"),
  "../../dist/index.js"
);
const rrwebStylePath = path.resolve(rrwebScriptPath, "../style.css");
const rrwebRaw = fs.readFileSync(rrwebScriptPath, "utf-8");
const rrwebStyle = fs.readFileSync(rrwebStylePath, "utf-8");
interface Config {
  // start playback delay time
  startDelayTime?: number,
} 

function getHtml(
  events: Array<any>,
  config?: Omit<RRwebPlayerOptions["props"] & Config, "events">
): string {
  return `
<html>
  <head>
  <style>${rrwebStyle}</style>
  </head>
  <body>
    <script>
      ${rrwebRaw};
      /*<!--*/
      const events = ${JSON.stringify(events).replace(
        /<\/script>/g,
        "<\\/script>"
      )};
      /*-->*/
      const userConfig = ${config ? JSON.stringify(config) : {}};
      window.replayer = new rrwebPlayer({
        target: document.body,
        props: {
          events,
          showController: false,
          autoPlay: false, // autoPlay off by default
          ...userConfig
        },
      }); 
      
      window.replayer.addEventListener('finish', () => window.onReplayFinish());
      let time = userConfig.startDelayTime || 1000 // start playback delay time, default 1000ms
      let start = fn => {
        setTimeout(() => {
          fn()
        }, time)
      }
      // It is recommended not to play auto by default. If the speed is not 1, the page block in the early stage of autoPlay will be blank
      if (userConfig.autoPlay) {
        start = fn => {
          fn()
        };
      }
      start(() => {
        window.onReplayStart();
        window.replayer.play();
      })
    </script>
  </body>
</html>
`;
}

type RRvideoConfig = {
  fps: number;
  headless: boolean;
  chromePath?: string;
  input: string;
  cb: (file: string, error: null | Error) => void;
  output: string;
  rrwebPlayer: Omit<RRwebPlayerOptions["props"] & Config, "events">;
  videoBitrate?: string;
};

const defaultConfig: RRvideoConfig = {
  fps: 30, // 提高帧率到30fps以获得更流畅的视频
  headless: true,
  chromePath:"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  input: "",
  cb: () => {},
  output: "rrvideo-output.mp4",
  rrwebPlayer: {},
  videoBitrate: "2000k", // 优化比特率平衡质量和流畅度
};

class RRvideo {
  private browser!: Browser;
  private page!: Page;
  private state: "idle" | "recording" | "closed" = "idle";
  private config: RRvideoConfig;

  constructor(config?: Partial<RRvideoConfig> & { input: string }) {
    this.config = {
      fps: config?.fps || defaultConfig.fps,
      headless: config?.headless || defaultConfig.headless,
      chromePath: config?.chromePath || defaultConfig.chromePath,
      input: config?.input || defaultConfig.input,
      cb: config?.cb || defaultConfig.cb,
      output: config?.output || defaultConfig.output,
      rrwebPlayer: config?.rrwebPlayer || defaultConfig.rrwebPlayer,
      videoBitrate: config?.videoBitrate || defaultConfig.videoBitrate,
    };
  }

  public async init() {
    try {
      this.browser = await puppeteer.launch({
        headless: this.config.headless,
        executablePath: this.config.chromePath,
      });
      this.page = await this.browser.newPage();
      // 使用整数倍设备缩放因子避免渲染问题
      await this.page.setViewport({width: 1920,height: 1080,deviceScaleFactor: 2});
      await this.page.goto("about:blank");

      await this.page.exposeFunction("onReplayStart", () => {
        this.startRecording();
      });

      await this.page.exposeFunction("onReplayFinish", () => {
        this.finishRecording();
      });

      const eventsPath = path.isAbsolute(this.config.input)
        ? this.config.input
        : path.resolve(process.cwd(), this.config.input);
      const events = JSON.parse(fs.readFileSync(eventsPath, "utf-8"));
      await this.page.setContent(getHtml(events, this.config.rrwebPlayer));
    } catch (error) {
      this.config.cb("", error as any);
    }
  }

  private async startRecording() {
    this.state = "recording";
    let wrapperSelector = ".replayer-wrapper";
    if (this.config.rrwebPlayer.width && this.config.rrwebPlayer.height) {
      wrapperSelector = ".rr-player";
    }
    const wrapperEl = await this.page.$(wrapperSelector);

    if (!wrapperEl) {
      throw new Error("failed to get replayer element");
    }

    // start ffmpeg
    const args = [
      // fps
      "-framerate",
      this.config.fps.toString(),
      // input - 使用image2pipe格式输入PNG图像
      "-f",
      "image2pipe",
      "-i",
      "-",
      // 视频编码器设置 - 使用h264编码
      "-c:v",
      "libx264",
      // 质量参数 - 使用合理的CRF值平衡质量和流畅度
      "-crf",
      "18", // 使用CRF 18获得高质量但更流畅的编码
      // 编码预设 - 使用中等预设获得更好的流畅度
      "-preset",
      "medium",
      // 确保关键帧足够频繁，有利于Seek操作
      "-g",
      (this.config.fps).toString(), // 减少关键帧间隔提高流畅度
      // 使用zerolatency调优设置，降低延迟
      "-tune",
      "zerolatency",
      // 输出设置
      "-y",
      // 使用合理的比特率设置
      "-b:v",
      this.config.videoBitrate,
      // 添加最大比特率和缓冲设置
      "-maxrate",
      this.config.videoBitrate,
      "-bufsize",
      (parseInt(this.config.videoBitrate!.replace('k', '')) * 2) + 'k',
      // 添加流畅度优化参数
      "-threads",
      "0", // 使用所有可用线程
      "-movflags",
      "+faststart", // 优化网络播放

      this.config.output,
    ];

    const ffmpegProcess = spawn("ffmpeg", args as any);
    ffmpegProcess.stderr.setEncoding("utf-8");
    ffmpegProcess.stderr.on("data", console.log);

    let processError: Error | null = null;

    const timer = setInterval(async () => {
      if (this.state === "recording" && !processError) {
        try {
          // 使用基本截图设置避免兼容性问题
          const buffer = await wrapperEl.screenshot({
            encoding: "binary",
          });
          ffmpegProcess.stdin.write(buffer);
        } catch (error) {
          // ignore
        }
      } else {
        clearInterval(timer);
        if (this.state === "closed" && !processError) {
          ffmpegProcess.stdin.end();
        }
      }
    }, 1000 / this.config.fps);

    const outputPath = path.isAbsolute(this.config.output)
      ? this.config.output
      : path.resolve(process.cwd(), this.config.output);
    ffmpegProcess.on("close", () => {
      if (processError) {
        return;
      }
      this.config.cb(outputPath, null);
    });
    ffmpegProcess.on("error", (error) => {
      if (processError) {
        return;
      }
      processError = error;
      this.config.cb(outputPath, error);
    });
    ffmpegProcess.stdin.on("error", (error) => {
      if (processError) {
        return;
      }
      processError = error;
      this.config.cb(outputPath, error);
    });
  }

  private async finishRecording() {
    this.state = "closed";
    await this.browser.close();
  }
}

export function transformToVideo(
  config: Partial<RRvideoConfig> & { input: string }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const rrvideo = new RRvideo({
      ...config,
      cb(file, error) {
        if (error) {
          return reject(error);
        }
        resolve(file);
      },
    });
    rrvideo.init();
  });
}
