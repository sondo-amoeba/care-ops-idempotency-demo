import { CoordinatorSignalType } from "../entities";
import { PatientIntent } from "./patient-intent";

export interface StartCoordinatorRunInput {
  interactionId: string;
  signal: CoordinatorSignalType;
  patientIntent?: PatientIntent;
}
