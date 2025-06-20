import {
  createProgram,
  createShader,
  getCanvasToClipSpaceProjectionMatrix,
  resizeCanvasToDisplaySize,
  setQuadVertices,
} from "@/app/lib/utils/webgl";
import { VERTEX_SHADER, FRAGMENT_SHADER } from "./shaders";
import { GraphsheetData } from "./types";

export const initialise = async (canvas: HTMLCanvasElement) => {
  const gl = canvas.getContext("webgl");

  if (!gl) throw new Error("Failed to inistialise WebGL");

  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);

  if (!fragmentShader) throw new Error("Failed to create fragment shader");

  const vertexShader = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);

  if (!vertexShader) throw new Error("Failed to create fragment shader");

  const program = createProgram(gl, vertexShader, fragmentShader);
  if (!program) throw new Error("Failed to create program");

  const canvasProjectionMatrixUniformLocation = gl.getUniformLocation(
    program,
    "u_canvasProjectionMatrix"
  );

  const canvasResolutionUniformLocation = gl.getUniformLocation(
    program,
    "u_resolution"
  );

  const majorCellLineColorUniformLocation = gl.getUniformLocation(
    program,
    "u_majorCellLineColor"
  );

  const minorCellLineColorUniformLocation = gl.getUniformLocation(
    program,
    "u_minorCellLineColor"
  );

  const majorCellLineWidthUniformLocation = gl.getUniformLocation(
    program,
    "u_majorCellLineWidth"
  );

  const minorCellLineWidthUniformLocation = gl.getUniformLocation(
    program,
    "u_minorCellLineWidth"
  );

  const majorCellDimUniformLocation = gl.getUniformLocation(
    program,
    "u_majorCellDim"
  );

  const minorCellDimUniformLocation = gl.getUniformLocation(
    program,
    "u_minorCellDim"
  );

  const positionAttributeLocation = gl.getAttribLocation(program, "a_position");

  const positionBuffer = gl.createBuffer();

  gl.useProgram(program);

  return {
    render: (graphData: GraphsheetData) => {
      gl.useProgram(program);

      // gl.enable(gl.BLEND);
      // gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      resizeCanvasToDisplaySize(canvas);

      gl.viewport(0, 0, canvas.width, canvas.height);

      gl.clearColor(0, 0, 0, 0);

      gl.clear(gl.COLOR_BUFFER_BIT);

      const canvasProjectionMatrix = getCanvasToClipSpaceProjectionMatrix(
        canvas.width,
        canvas.height
      );

      gl.uniformMatrix3fv(
        canvasProjectionMatrixUniformLocation,
        false,
        canvasProjectionMatrix
      );

      gl.uniform2fv(canvasResolutionUniformLocation, [
        canvas.width,
        canvas.height,
      ]);

      gl.uniform4fv(
        majorCellLineColorUniformLocation,
        graphData.majorCell.lineColor.map((c, i) => (i < 3 ? c / 255 : c))
      );

      gl.uniform4fv(
        minorCellLineColorUniformLocation,
        graphData.minorCell.lineColor.map((c, i) => (i < 3 ? c / 255 : c))
      );

      gl.uniform1f(
        majorCellLineWidthUniformLocation,
        graphData.majorCell.lineWidth
      );

      gl.uniform1f(
        minorCellLineWidthUniformLocation,
        graphData.minorCell.lineWidth
      );

      gl.uniform1f(majorCellDimUniformLocation, graphData.majorCell.cellDim);

      gl.uniform1f(minorCellDimUniformLocation, graphData.minorCell.cellDim);

      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);

      setQuadVertices(gl);

      gl.enableVertexAttribArray(positionAttributeLocation);

      gl.vertexAttribPointer(
        positionAttributeLocation,
        2,
        gl.FLOAT,
        false,
        0,
        0
      );

      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },
    cleanup: () => {
      if (!gl || !program) return;

      // Delete shaders and program
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);

      // Delete buffer
      if (positionBuffer) gl.deleteBuffer(positionBuffer);

      // Lose context if extension is supported
      const loseContextExt = gl.getExtension("WEBGL_lose_context");
      if (loseContextExt) {
        loseContextExt.loseContext();
      }
    },
  };
};
