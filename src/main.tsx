import { render } from "preact";
import App from "./App";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import "./theme/global.css";

render(<App />, document.getElementById("root")!);
