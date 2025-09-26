import React from "react";
import { render } from "ink";
import { App } from "./ui/App";
import { setupGlobalErrorHandlers } from "./runtime-errors";

setupGlobalErrorHandlers();

render(<App />);
