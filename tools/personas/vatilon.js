/**
 * Persona: Vatilon "Sinis 5MP IPC".
 *
 * Observed on the real unit (GOVERNOR.md, Part 2; bug class 1): ONVIF imaging
 * accepts a write, reports success, and changes nothing. The base mock
 * already reproduces this as MOCK_IMAGING_MODE=ignore; the persona just names
 * the device it was observed on. (Its proprietary CGI is mocked separately by
 * tools/mock-vendor-camera.js.)
 */
export const persona = {
  name: 'vatilon',
  defaults: { imagingMode: 'ignore' },
};
