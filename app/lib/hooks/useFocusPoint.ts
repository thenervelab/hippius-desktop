import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";

const CENTER_POSITION = new THREE.Vector3(0, 0, 0);

/**
 * Hook to focus the camera on a 3D point when selected
 * @param isSelected Whether the point is currently selected
 * @param ref Reference to the group containing the point
 */
export function useFocusPoint(
  isSelected: boolean | undefined,
  ref: React.RefObject<THREE.Group<THREE.Object3DEventMap> | null>
) {
  const { camera } = useThree();

  useEffect(() => {
    // Only proceed if isSelected is explicitly true
    if (isSelected === true && ref.current) {
      // Get the world position of this indicator
      const worldPos = new THREE.Vector3();
      ref.current.getWorldPosition(worldPos);

      // Calculate the direction from center to this point
      const direction = worldPos.clone().sub(CENTER_POSITION).normalize();

      // Set camera position to view this point (simple approach)
      const cameraDistance = camera.position.length();
      const newPosition = direction.clone().multiplyScalar(cameraDistance);

      // Smoothly move camera to new position
      const duration = 500; // milliseconds
      const startPosition = camera.position.clone();
      const startTime = Date.now();

      function updateCamera() {
        const elapsed = Date.now() - startTime;
        const t = Math.min(elapsed / duration, 1);
        const ease = t * t * (3 - 2 * t); // Smoothstep easing

        camera.position.lerpVectors(startPosition, newPosition, ease);
        camera.lookAt(CENTER_POSITION);

        if (t < 1) requestAnimationFrame(updateCamera);
      }

      updateCamera();
    }
  }, [isSelected, camera, ref]);
}

export default useFocusPoint;
